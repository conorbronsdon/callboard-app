/**
 * D1 + Drizzle handle.
 *
 * ⚠️ D1 has NO interactive transactions. `db.transaction(...)` throws on the D1
 * driver. For atomic multi-statement writes use `db.batch([...])`, which sends
 * the statements as one D1 batch:
 *
 *   await db.batch([
 *     db.insert(sessions).values(row),
 *     db.insert(sessionParticipants).values(link),
 *   ]);
 *
 * Also: SQLite caps a single prepared statement at ~100 bound parameters, so
 * chunk bulk inserts (`columns * rows <= 100`) rather than building one giant
 * VALUES list. `chunkForBind` below does the arithmetic for you.
 */
import { drizzle } from "drizzle-orm/d1";

import { appEnv } from "~/lib/env.server";
import * as schema from "./schema";

export function getDb() {
  return drizzle(appEnv().DB, { schema });
}

export type DB = ReturnType<typeof getDb>;

/** Max bound parameters D1 will accept in one prepared statement. Hard limit. */
export const MAX_BOUND_PARAMS = 100;

/**
 * What we actually build to. The 10-parameter gap is deliberate headroom: an IN
 * list is rarely the only bound value in its statement (an event id, a status,
 * a SET clause all ride along), and building to exactly 100 leaves a statement
 * one predicate away from `D1_ERROR: too many SQL variables`.
 */
export const BOUND_PARAM_BUDGET = 90;

/**
 * Split rows into batches that stay under the bound-parameter budget.
 * `columnsPerRow` is how many bound parameters each row costs.
 *
 * ⚠️ For multi-row INSERTs prefer `chunkedInsert`, which measures the cost
 * instead of trusting a hand-counted number — see the note there.
 */
export function chunkForBind<T>(rows: T[], columnsPerRow: number): T[][] {
  const perChunk = Math.max(1, Math.floor(BOUND_PARAM_BUDGET / Math.max(1, columnsPerRow)));
  const chunks: T[][] = [];
  for (let i = 0; i < rows.length; i += perChunk) {
    chunks.push(rows.slice(i, i + perChunk));
  }
  return chunks;
}

/** Anything drizzle can render to SQL without executing it. */
type Measurable = { toSQL: () => { params: unknown[] } };

/**
 * Build a multi-row INSERT as however many statements it takes to keep each one
 * inside `BOUND_PARAM_BUDGET`, MEASURING what drizzle actually binds.
 *
 * Why measured and not counted: drizzle binds a parameter for every column
 * carrying a *scalar* default even when the caller never supplies it. `tasks`
 * has `kind: text(...).default("manual")`, so a task row you build with ten keys
 * is eleven bound parameters on the wire. A hand-written `columnsPerRow` cannot
 * see that, and it silently drifts the moment the schema gains a default —
 * which is exactly how a "chunked" queue commit still shipped 110-parameter
 * statements to D1 and blew the 100 cap.
 *
 * `build` is called once per row to price it, then once per chunk for real.
 */
export function chunkedInsert<Row, Stmt extends Measurable>(
  rows: Row[],
  build: (chunk: Row[]) => Stmt,
): Stmt[] {
  if (rows.length === 0) return [];

  const costPerRow = rows.map((row) => build([row]).toSQL().params.length);

  const statements: Stmt[] = [];
  let start = 0;
  while (start < rows.length) {
    // Always take at least one row: a single row wider than the budget cannot
    // be split any further, and silently dropping it would be worse.
    let end = start + 1;
    let cost = costPerRow[start];
    while (end < rows.length && cost + costPerRow[end] <= BOUND_PARAM_BUDGET) {
      cost += costPerRow[end];
      end += 1;
    }
    statements.push(build(rows.slice(start, end)));
    start = end;
  }
  return statements;
}

export { schema };
