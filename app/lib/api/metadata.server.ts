/**
 * ONE generic handler for the five metadata families (tracks / rooms / tags /
 * formats / levels).
 *
 * Sessionboard ships seven near-identical CRUD families and 29 of their 177
 * operations are metadata (research/sessionboard-api.md §6 #13, Appendix). The
 * families differ by exactly two things — which table, and which extra column —
 * so one handler plus the `metadataTables` map in app/db/schema.ts covers all
 * fifteen routes. Adding a sixth family is a schema line, not a route file.
 *
 * (We ship five, not seven: `languages` and `statuses` have no table in this
 * product — English-only per DECISIONS #6, and statuses are the fixed enum from
 * DECISIONS #15 rather than per-event rows.)
 */
import { and, asc, count, eq, or, sql } from "drizzle-orm";

import { getDb } from "~/db/client.server";
import { METADATA_FAMILIES, metadataTables, type MetadataFamily } from "~/db/schema";

import type { Paging } from "./envelope";
import type { MetadataInput } from "./serialize";

export { METADATA_FAMILIES, type MetadataFamily };

export function isMetadataFamily(value: string): value is MetadataFamily {
  return (METADATA_FAMILIES as readonly string[]).includes(value);
}

/**
 * `/v1/event/x/tracks` -> "tracks"; `/v1/event/x/tracks/create` -> "tracks".
 * Lives here (not in a route module) because a route importing another ROUTE's
 * export drags the imported route into the client graph — which is exactly how
 * this module's server-only import broke `npm run build` (fix lane, Sat 07:50).
 */
export function familyFromPath(pathname: string): MetadataFamily | null {
  const segments = pathname.split("/").filter(Boolean);
  const last = segments[segments.length - 1];
  const candidate = last === "create" ? segments[segments.length - 2] : last;
  return candidate && isMetadataFamily(candidate) ? candidate : null;
}

/**
 * The union of the five tables is not one drizzle type, so the query builder is
 * handed the family's table through a narrow cast and the rows come back as the
 * superset row shape. Runtime is unaffected: `select()` returns exactly the
 * columns the table has, and `serializeMetadata` only emits keys that are
 * present (`undefined` extras are dropped, not rendered as null).
 */
type AnyMetadataTable = (typeof metadataTables)["rooms"];

type MetadataRow = MetadataInput & { eventId: string };

function tableFor(family: MetadataFamily): AnyMetadataTable {
  return metadataTables[family] as AnyMetadataTable;
}

export interface MetadataFilters {
  text: string | null;
}

export function normalizeMetadataFilters(raw: unknown): MetadataFilters {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { text: null };
  const input = raw as Record<string, unknown>;
  const text = input.text ?? input.q ?? input.name ?? input.search;
  return { text: text ? String(text).trim() || null : null };
}

export async function listMetadata(
  family: MetadataFamily,
  eventId: string,
  filters: MetadataFilters,
  paging: Paging,
): Promise<{ rows: MetadataRow[]; total: number }> {
  const db = getDb();
  const table = tableFor(family);

  const pattern = filters.text
    ? `%${filters.text.replace(/[\\%_]/g, (char) => `\\${char}`)}%`
    : null;
  const where = pattern
    ? and(eq(table.eventId, eventId), or(sql`${table.name} like ${pattern} escape '\\'`))
    : eq(table.eventId, eventId);

  const [rows, totals] = await Promise.all([
    db
      .select()
      .from(table)
      .where(where)
      .orderBy(asc(table.order), asc(table.name))
      .limit(paging.pageSize)
      .offset(paging.offset),
    db.select({ n: count() }).from(table).where(where),
  ]);

  return { rows: rows as unknown as MetadataRow[], total: Number(totals[0]?.n ?? 0) };
}

export type MetadataWriteResult =
  | { ok: true; row: MetadataRow }
  | { ok: false; message: string };

/**
 * Create one metadata row. Every family takes `name` + `order`; `color`,
 * `capacity` and `default_minutes` are accepted only where the family has the
 * column, so an integration cannot invent a `capacity` on a tag and believe it
 * was stored.
 */
export async function createMetadata(
  family: MetadataFamily,
  eventId: string,
  raw: unknown,
): Promise<MetadataWriteResult> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, message: "Body must be a JSON object." };
  }
  const input = raw as Record<string, unknown>;

  const name = String(input.name ?? "").trim();
  if (!name) return { ok: false, message: "`name` is required." };

  const values: Record<string, unknown> = { eventId, name };

  if (input.order !== undefined) {
    const order = Number(input.order);
    if (!Number.isInteger(order)) return { ok: false, message: "`order` must be an integer." };
    values.order = order;
  }

  if (family === "tracks" && input.color !== undefined) {
    values.color = input.color === null ? null : String(input.color);
  }
  if (family === "rooms" && input.capacity !== undefined) {
    if (input.capacity === null) {
      values.capacity = null;
    } else {
      const capacity = Number(input.capacity);
      if (!Number.isInteger(capacity) || capacity < 0) {
        return { ok: false, message: "`capacity` must be a non-negative integer or null." };
      }
      values.capacity = capacity;
    }
  }
  if (family === "formats") {
    const minutes = input.default_minutes ?? input.defaultMinutes;
    if (minutes !== undefined) {
      if (minutes === null) {
        values.defaultMinutes = null;
      } else {
        const parsed = Number(minutes);
        if (!Number.isInteger(parsed) || parsed <= 0) {
          return {
            ok: false,
            message: "`default_minutes` must be a positive integer or null.",
          };
        }
        values.defaultMinutes = parsed;
      }
    }
  }

  const table = tableFor(family);
  const duplicateMessage = `A ${family.replace(/s$/, "")} named "${name}" already exists.`;

  /*
   * Explicit pre-check, not just a caught constraint error. Every family has a
   * UNIQUE (event_id, name) index, but the driver's error text is not part of
   * any contract — drizzle wraps it as "Failed query: insert into …" and the
   * SQLite message only appears on `cause`. Sniffing that string is how you get
   * a helpful 400 in one environment and a 500 in another. The catch below is
   * the race backstop, not the primary path.
   */
  const clash = await getDb()
    .select({ id: table.id })
    .from(table)
    .where(and(eq(table.eventId, eventId), eq(table.name, name)))
    .limit(1);
  if (clash.length > 0) return { ok: false, message: duplicateMessage };

  try {
    const rows = await getDb()
      .insert(table)
      .values(values as never)
      .returning();
    return { ok: true, row: rows[0] as unknown as MetadataRow };
  } catch (error) {
    if (/unique/i.test(errorChainText(error))) {
      return { ok: false, message: duplicateMessage };
    }
    return {
      ok: false,
      message: `Create failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/** Message plus every `cause` in the chain — drivers hide the real text there. */
function errorChainText(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  for (let depth = 0; current !== null && current !== undefined && depth < 5; depth += 1) {
    if (current instanceof Error) {
      parts.push(current.message);
      current = (current as { cause?: unknown }).cause;
    } else {
      parts.push(String(current));
      break;
    }
  }
  return parts.join(" | ");
}
