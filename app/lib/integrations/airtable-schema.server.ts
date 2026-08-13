/**
 * Airtable base PREFLIGHT — the Metadata API half of the one-way mirror.
 *
 * The mirror (airtable.server.ts) pushes records with `performUpsert`. That call
 * fails with a 422 if the table does not exist or a field name is unknown, and it
 * fails PER TABLE: a base missing only `Submissions` still accepts Speakers and
 * Sessions, so a first run against a half-built base lands two tables and errors
 * on the third. The rows are not lost — the watermark only advances on a clean
 * run — but the operator's base is left in a state nobody chose.
 *
 * This module is the answer to that: read the base's real schema, diff it against
 * what the mirror emits, and report exactly what is missing BEFORE any records
 * move. When the token carries `schema.bases:write` it can also create what is
 * absent. It is deliberately CREATE-ONLY:
 *   - it never renames, retypes, or deletes an existing table or field;
 *   - it never touches a table outside MIRROR_FIELD_SPEC;
 *   - it never issues DELETE or PATCH to the Metadata API at all.
 *
 * Why this does not import airtable.server.ts: `write-path.test.ts` pins the set
 * of modules allowed to import the mirror, and that spec is frozen for the
 * release. The config read and the API base below are therefore duplicated here
 * rather than shared. `airtable-projection.test.ts` holds the two in agreement.
 */
import { appEnv } from "~/lib/env.server";

export const AIRTABLE_META_BASE = "https://api.airtable.com/v0/meta/bases";

/** The upsert key. Must match AIRTABLE_MERGE_FIELD in airtable.server.ts. */
export const MERGE_FIELD = "Callboard ID";

export interface AirtableFieldSpec {
  name: string;
  type: string;
  options?: Record<string, unknown>;
}

/** Airtable rejects a dateTime field created without explicit formatting. */
const DATE_TIME: AirtableFieldSpec["options"] = {
  dateFormat: { name: "iso" },
  timeFormat: { name: "24hour" },
  timeZone: "utc",
};

/**
 * EVERY field the mirror is allowed to write, per table.
 *
 * This doubles as the PII allowlist. Adding a line here is the only way a new
 * column can reach Airtable, and `airtable-projection.test.ts` fails if the
 * mirror's projection and this spec drift apart in either direction.
 *
 * What personal data crosses, stated exactly: Airtable receives speaker id,
 * email, name, company, title and bio in `Speakers`, and speaker DISPLAY NAMES
 * — no addresses — in the `Speakers` column of `Sessions` and `Submissions`.
 * Everything else is programme metadata the event publishes anyway.
 *
 * `Email` is present by deliberate choice, and in ONE table: the mirror writes
 * into the organiser's own base, and a speaker roster without contact addresses
 * is not a roster. Nothing widens that — no answers blob, no auth material, no
 * internal `__`-prefixed keys, and no addresses on the session tables, which
 * are the ones an organizer shares by link. `airtable.test.ts` binds each
 * column to its table against the real payload, so a `Speakers` column that
 * went back to joining addresses fails there rather than passing a name scan.
 */
export const MIRROR_FIELD_SPEC: Record<string, AirtableFieldSpec[]> = {
  Speakers: [
    { name: MERGE_FIELD, type: "singleLineText" },
    { name: "Email", type: "email" },
    { name: "Name", type: "singleLineText" },
    { name: "Company", type: "singleLineText" },
    { name: "Title", type: "singleLineText" },
    { name: "Bio", type: "multilineText" },
    { name: "Updated At", type: "dateTime", options: DATE_TIME },
  ],
  Sessions: [
    { name: MERGE_FIELD, type: "singleLineText" },
    { name: "Reference", type: "singleLineText" },
    { name: "Title", type: "singleLineText" },
    { name: "Status", type: "singleLineText" },
    { name: "Track", type: "singleLineText" },
    { name: "Speakers", type: "multilineText" },
    { name: "Room", type: "singleLineText" },
    { name: "Starts At", type: "dateTime", options: DATE_TIME },
    { name: "Ends At", type: "dateTime", options: DATE_TIME },
    { name: "Public", type: "checkbox", options: { icon: "check", color: "greenBright" } },
    { name: "Updated At", type: "dateTime", options: DATE_TIME },
  ],
  Submissions: [
    { name: MERGE_FIELD, type: "singleLineText" },
    { name: "Reference", type: "singleLineText" },
    { name: "Title", type: "singleLineText" },
    { name: "Status", type: "singleLineText" },
    { name: "Track", type: "singleLineText" },
    { name: "Speakers", type: "multilineText" },
    { name: "Updated At", type: "dateTime", options: DATE_TIME },
  ],
};

export interface SchemaConfig {
  token: string;
  baseId: string;
}

/** Null unless BOTH env vars are present — a half-configured mirror is off. */
export function schemaConfig(): SchemaConfig | null {
  const env = appEnv();
  const token = env.AIRTABLE_TOKEN;
  const baseId = env.AIRTABLE_BASE;
  if (!token || !baseId) return null;
  return { token, baseId };
}

interface RemoteField {
  id?: string;
  name?: string;
}
interface RemoteTable {
  id?: string;
  name?: string;
  fields?: RemoteField[];
}

export interface MissingField {
  table: string;
  field: string;
}

export interface SchemaDiff {
  /** Tables in the spec with no counterpart in the base. */
  missingTables: string[];
  /** Fields absent from a table that DOES exist. */
  missingFields: MissingField[];
}

/**
 * What the base lacks. Tables missing entirely are reported as tables, not as a
 * list of every one of their fields — an operator staring at 25 "missing field"
 * lines for one absent table learns less than one line saying the table is gone.
 */
export function diffBaseSchema(remote: RemoteTable[]): SchemaDiff {
  const byName = new Map<string, RemoteTable>();
  for (const table of remote) {
    if (typeof table?.name === "string") byName.set(table.name, table);
  }

  const missingTables: string[] = [];
  const missingFields: MissingField[] = [];

  for (const [tableName, fields] of Object.entries(MIRROR_FIELD_SPEC)) {
    const table = byName.get(tableName);
    if (!table) {
      missingTables.push(tableName);
      continue;
    }
    const present = new Set(
      (table.fields ?? [])
        .map((field) => field?.name)
        .filter((name): name is string => typeof name === "string"),
    );
    for (const field of fields) {
      if (!present.has(field.name)) {
        missingFields.push({ table: tableName, field: field.name });
      }
    }
  }

  return { missingTables, missingFields };
}

type FetchLike = typeof fetch;

export interface SchemaDeps {
  fetchImpl?: FetchLike;
}

export interface SchemaReport {
  ok: boolean;
  configured: boolean;
  /** True when the token was accepted for schema READS. */
  readable: boolean;
  /** True when the run created at least one table or field. */
  changed: boolean;
  message: string;
  details: Record<string, unknown>;
}

async function metaRequest(
  config: SchemaConfig,
  path: string,
  fetchImpl: FetchLike,
  init?: { method: "POST"; body: unknown },
): Promise<{ ok: true; data: unknown } | { ok: false; status: number; error: string }> {
  try {
    const response = await fetchImpl(`${AIRTABLE_META_BASE}/${config.baseId}${path}`, {
      method: init?.method ?? "GET",
      headers: {
        authorization: `Bearer ${config.token}`,
        "content-type": "application/json",
      },
      ...(init ? { body: JSON.stringify(init.body) } : {}),
    });

    if (!response.ok) {
      const text = await response.text();
      return { ok: false, status: response.status, error: `${response.status} ${text.slice(0, 200)}` };
    }
    return { ok: true, data: await response.json() };
  } catch (error) {
    return { ok: false, status: 0, error: error instanceof Error ? error.message : String(error) };
  }
}

/** A missing scope reads as 403 (and, on some tokens, 404 on the meta route). */
function isScopeDenial(status: number): boolean {
  return status === 401 || status === 403 || status === 404;
}

/**
 * Preflight the base, optionally creating what is absent.
 *
 * Safe to call unconfigured — that is the fresh-clone default and it must read
 * as a clean "not configured", never an error, and never a network call.
 */
export async function ensureAirtableSchema(
  options: { create?: boolean } = {},
  deps: SchemaDeps = {},
): Promise<SchemaReport> {
  const config = schemaConfig();
  if (!config) {
    return {
      ok: true,
      configured: false,
      readable: false,
      changed: false,
      message:
        "airtable-schema: not configured — set AIRTABLE_TOKEN and AIRTABLE_BASE to enable the mirror.",
      details: { configured: false },
    };
  }

  const fetchImpl = deps.fetchImpl ?? fetch;
  const read = await metaRequest(config, "/tables", fetchImpl);

  if (!read.ok) {
    // No schema scope is a legitimate, common configuration: a data-only token
    // mirrors records perfectly well against a base the operator built by hand.
    // Say so plainly and list what we would have checked, rather than failing.
    const scoped = isScopeDenial(read.status);
    return {
      ok: false,
      configured: true,
      readable: false,
      changed: false,
      message: scoped
        ? `airtable-schema: the token cannot read this base's schema (${read.error}). Add the schema.bases:read scope, or create these tables by hand: ${Object.keys(MIRROR_FIELD_SPEC).join(", ")}.`
        : `airtable-schema: could not read the base schema (${read.error}).`,
      details: {
        configured: true,
        readable: false,
        error: read.error,
        expectedTables: Object.keys(MIRROR_FIELD_SPEC),
      },
    };
  }

  const remote = Array.isArray((read.data as { tables?: unknown })?.tables)
    ? ((read.data as { tables: RemoteTable[] }).tables ?? [])
    : [];
  const diff = diffBaseSchema(remote);
  const outstanding = diff.missingTables.length + diff.missingFields.length;

  if (outstanding === 0) {
    return {
      ok: true,
      configured: true,
      readable: true,
      changed: false,
      message: `airtable-schema: base is ready — ${Object.keys(MIRROR_FIELD_SPEC).length} table(s), all mirrored fields present.`,
      details: { configured: true, readable: true, missingTables: [], missingFields: [] },
    };
  }

  if (!options.create) {
    return {
      ok: false,
      configured: true,
      readable: true,
      changed: false,
      message: describeMissing(diff),
      details: {
        configured: true,
        readable: true,
        missingTables: diff.missingTables,
        missingFields: diff.missingFields,
      },
    };
  }

  const createdTables: string[] = [];
  const createdFields: string[] = [];
  const errors: string[] = [];

  // Tables first: a table created here arrives with its full field set, so any
  // missingFields entry for it is already satisfied and must not be re-created.
  for (const tableName of diff.missingTables) {
    const result = await metaRequest(config, "/tables", fetchImpl, {
      method: "POST",
      body: { name: tableName, fields: MIRROR_FIELD_SPEC[tableName] },
    });
    if (result.ok) createdTables.push(tableName);
    else errors.push(`create table ${tableName}: ${result.error}`);
  }

  const tableIds = new Map<string, string>();
  for (const table of remote) {
    if (typeof table?.name === "string" && typeof table?.id === "string") {
      tableIds.set(table.name, table.id);
    }
  }

  for (const missing of diff.missingFields) {
    // Skipped by construction: the table did not exist, so it was just created
    // WITH this field. Re-posting it would 422 on a duplicate name.
    if (diff.missingTables.includes(missing.table)) continue;

    const tableId = tableIds.get(missing.table);
    if (!tableId) {
      errors.push(`create field ${missing.table}.${missing.field}: table id unknown`);
      continue;
    }
    const spec = MIRROR_FIELD_SPEC[missing.table]?.find((f) => f.name === missing.field);
    if (!spec) continue;

    const result = await metaRequest(config, `/tables/${tableId}/fields`, fetchImpl, {
      method: "POST",
      body: spec,
    });
    if (result.ok) createdFields.push(`${missing.table}.${missing.field}`);
    else errors.push(`create field ${missing.table}.${missing.field}: ${result.error}`);
  }

  const ok = errors.length === 0;
  const changed = createdTables.length > 0 || createdFields.length > 0;

  return {
    ok,
    configured: true,
    readable: true,
    changed,
    message: ok
      ? `airtable-schema: created ${createdTables.length} table(s) and ${createdFields.length} field(s); base is ready.`
      : `airtable-schema: created ${createdTables.length} table(s) and ${createdFields.length} field(s), ${errors.length} failed. ${errors[0]}`,
    details: {
      configured: true,
      readable: true,
      createdTables,
      createdFields,
      errors,
    },
  };
}

function describeMissing(diff: SchemaDiff): string {
  const parts: string[] = [];
  if (diff.missingTables.length) {
    parts.push(`missing table(s): ${diff.missingTables.join(", ")}`);
  }
  if (diff.missingFields.length) {
    parts.push(
      `missing field(s): ${diff.missingFields
        .map((entry) => `${entry.table}.${entry.field}`)
        .join(", ")}`,
    );
  }
  return `airtable-schema: base is not ready — ${parts.join("; ")}. Re-run with schema.bases:write to create them, or add them in Airtable.`;
}
