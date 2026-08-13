/**
 * A real-SQL D1 stand-in for unit tests, built on Node's built-in `node:sqlite`.
 * No new dependency: `node:sqlite` ships with Node 22 and drizzle-orm is already
 * a runtime dependency.
 *
 * Why not mock `getDb()`? Because the interesting bugs in this lane live in the
 * SQL — `db.batch()` ordering, the bound-parameter cap, conditional UPDATE ...
 * RETURNING for the magic-link use cap. A mock would pass whatever we told it
 * to. This runs the production code path (drizzle's D1 driver) against a real
 * SQLite engine with the real migration applied.
 *
 * Fidelity notes (deliberate, and they make tests stricter, not looser):
 * - Foreign keys are ENFORCED, so a batch whose statements are ordered wrong
 *   fails here exactly as it would on D1.
 * - `batch()` runs inside BEGIN/COMMIT and rolls back on error, matching D1's
 *   all-or-nothing batch semantics.
 */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const MIGRATIONS_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "db",
  "migrations",
);

type SqlParam = string | number | bigint | null | Uint8Array;

/** D1 accepts booleans/undefined from drizzle; node:sqlite throws on them. */
function normalizeParam(value: unknown): SqlParam {
  if (value === undefined || value === null) return null;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (value instanceof Date) return value.getTime();
  return value as SqlParam;
}

interface D1ResultShape {
  results: Record<string, unknown>[];
  success: true;
  meta: Record<string, unknown>;
}

class TestPreparedStatement {
  constructor(
    private readonly sqlite: DatabaseSync,
    private readonly sql: string,
    private readonly params: unknown[] = [],
  ) {}

  bind(...params: unknown[]): TestPreparedStatement {
    return new TestPreparedStatement(this.sqlite, this.sql, params);
  }

  private objectRows(): Record<string, unknown>[] {
    const statement = this.sqlite.prepare(this.sql);
    return statement.all(...this.params.map(normalizeParam)) as Record<
      string,
      unknown
    >[];
  }

  /**
   * Positional rows, NOT `Object.values(objectRow)`.
   *
   * A join that selects `tracks.name` and `forms.name` produces two result
   * columns both called `name`; collapsing them into an object drops one and
   * silently shifts every column after it. D1's own `raw()` is positional, and
   * drizzle routes every `select({...})` through it, so this has to be too.
   */
  private arrayRows(): unknown[][] {
    const statement = this.sqlite.prepare(this.sql);
    statement.setReturnArrays(true);
    // The node:sqlite types describe only the object shape; setReturnArrays
    // flips it to positional at runtime.
    return statement.all(...this.params.map(normalizeParam)) as unknown as unknown[][];
  }

  async all(): Promise<D1ResultShape> {
    return { results: this.objectRows(), success: true, meta: { changes: 0 } };
  }

  async raw(): Promise<unknown[][]> {
    return this.arrayRows();
  }

  async first(column?: string): Promise<unknown> {
    const row = this.objectRows()[0];
    if (!row) return null;
    return column === undefined ? row : (row[column] ?? null);
  }

  async run(): Promise<D1ResultShape> {
    const statement = this.sqlite.prepare(this.sql);
    const info = statement.run(...this.params.map(normalizeParam));
    return {
      results: [],
      success: true,
      meta: {
        changes: Number(info.changes),
        last_row_id: Number(info.lastInsertRowid),
        rows_written: Number(info.changes),
      },
    };
  }
}

class TestD1Database {
  constructor(private readonly sqlite: DatabaseSync) {}

  prepare(sql: string): TestPreparedStatement {
    return new TestPreparedStatement(this.sqlite, sql);
  }

  /** D1 runs a batch as one transaction; so do we, rollback included. */
  async batch(statements: TestPreparedStatement[]): Promise<D1ResultShape[]> {
    this.sqlite.exec("BEGIN");
    try {
      const out: D1ResultShape[] = [];
      for (const statement of statements) out.push(await statement.all());
      this.sqlite.exec("COMMIT");
      return out;
    } catch (error) {
      this.sqlite.exec("ROLLBACK");
      throw error;
    }
  }

  async exec(sql: string): Promise<{ count: number; duration: number }> {
    this.sqlite.exec(sql);
    return { count: 0, duration: 0 };
  }
}

export interface TestD1 {
  /** Cast to the binding type the app expects. */
  binding: unknown;
  sqlite: DatabaseSync;
  close(): void;
}

/** Fresh in-memory database with every generated migration applied, in order. */
export function createTestD1(): TestD1 {
  const sqlite = new DatabaseSync(":memory:");
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith(".sql"))
    .sort();

  if (files.length === 0) {
    throw new Error(`No migrations found in ${MIGRATIONS_DIR} — cannot build a test DB.`);
  }

  for (const file of files) {
    sqlite.exec(readFileSync(join(MIGRATIONS_DIR, file), "utf8"));
  }

  return {
    binding: new TestD1Database(sqlite),
    sqlite,
    close: () => sqlite.close(),
  };
}
