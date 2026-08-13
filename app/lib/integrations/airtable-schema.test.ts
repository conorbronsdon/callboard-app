/**
 * The Airtable base preflight: what it reads, what it refuses to do, and what
 * it creates.
 *
 * `fetch` is injected, so every assertion is about the request we would really
 * send to the Metadata API — verb, URL, body — rather than about a mock's shape.
 * Nothing here touches the network; a test that reached Airtable would hang the
 * release gate on someone else's rate limit.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { env, resetEnv } from "~/test/workers-env";

import {
  AIRTABLE_META_BASE,
  MERGE_FIELD,
  MIRROR_FIELD_SPEC,
  diffBaseSchema,
  ensureAirtableSchema,
  schemaConfig,
} from "./airtable-schema.server";

const CONFIG = { AIRTABLE_TOKEN: "pat_test_token", AIRTABLE_BASE: "appTESTBASE" };

interface Recorded {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: Record<string, unknown> | null;
}

/**
 * @param responses status + payload per call, in order; defaults to 200 with an
 * empty base.
 */
function recorder(responses: { status?: number; body?: unknown }[] = []) {
  const calls: Recorded[] = [];
  const impl = (async (input: unknown, init?: RequestInit) => {
    calls.push({
      url: String(input),
      method: init?.method ?? "GET",
      headers: Object.fromEntries(
        Object.entries((init?.headers ?? {}) as Record<string, string>),
      ),
      body: init?.body ? JSON.parse(String(init.body)) : null,
    });
    const next = responses[calls.length - 1] ?? {};
    const status = next.status ?? 200;
    return new Response(JSON.stringify(next.body ?? {}), { status });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

/** A base whose schema already matches MIRROR_FIELD_SPEC exactly. */
function completeBase() {
  return {
    tables: Object.entries(MIRROR_FIELD_SPEC).map(([name, fields], index) => ({
      id: `tbl${index}`,
      name,
      fields: fields.map((field) => ({ id: `fld-${field.name}`, name: field.name })),
    })),
  };
}

beforeEach(() => resetEnv());
afterEach(() => resetEnv());

describe("not configured", () => {
  it("MUST NOT FIRE: no credentials means no network call at all", async () => {
    expect(schemaConfig()).toBeNull();

    const { impl, calls } = recorder();
    const report = await ensureAirtableSchema({ create: true }, { fetchImpl: impl });

    expect(report.ok).toBe(true);
    expect(report.configured).toBe(false);
    expect(report.changed).toBe(false);
    expect(report.message).toContain("not configured");
    expect(calls).toHaveLength(0);
  });

  it("MUST NOT FIRE: half-configured is still off", async () => {
    Object.assign(env, { AIRTABLE_TOKEN: "pat_only" });
    expect(schemaConfig()).toBeNull();

    const { impl, calls } = recorder();
    expect((await ensureAirtableSchema({}, { fetchImpl: impl })).configured).toBe(false);
    expect(calls).toHaveLength(0);
  });
});

describe("diffBaseSchema", () => {
  it("MUST FIRE: an empty base is entirely missing", () => {
    const diff = diffBaseSchema([]);
    expect(diff.missingTables).toEqual(Object.keys(MIRROR_FIELD_SPEC));
    // A wholly absent table is reported once, not once per field.
    expect(diff.missingFields).toEqual([]);
  });

  it("MUST NOT FIRE: a complete base reports nothing missing", () => {
    const diff = diffBaseSchema(completeBase().tables);
    expect(diff.missingTables).toEqual([]);
    expect(diff.missingFields).toEqual([]);
  });

  it("names the individual field when only a column is absent", () => {
    const base = completeBase();
    const speakers = base.tables.find((table) => table.name === "Speakers");
    speakers!.fields = speakers!.fields.filter((field) => field.name !== "Bio");

    const diff = diffBaseSchema(base.tables);
    expect(diff.missingTables).toEqual([]);
    expect(diff.missingFields).toEqual([{ table: "Speakers", field: "Bio" }]);
  });

  it("MUST NOT FIRE: tables outside the spec are ignored, never proposed for change", () => {
    const base = completeBase();
    base.tables.push({
      id: "tblOTHER",
      name: "Sponsors",
      fields: [{ id: "fld1", name: "Anything" }],
    });
    const diff = diffBaseSchema(base.tables);
    expect(diff.missingTables).toEqual([]);
    expect(diff.missingFields).toEqual([]);
  });
});

describe("reading the base", () => {
  beforeEach(() => Object.assign(env, CONFIG));

  it("GETs the documented Metadata endpoint with a bearer token", async () => {
    const { impl, calls } = recorder([{ body: completeBase() }]);
    const report = await ensureAirtableSchema({}, { fetchImpl: impl });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`${AIRTABLE_META_BASE}/appTESTBASE/tables`);
    expect(calls[0].method).toBe("GET");
    expect(calls[0].headers.authorization).toBe("Bearer pat_test_token");
    expect(report.ok).toBe(true);
    expect(report.readable).toBe(true);
    expect(report.changed).toBe(false);
    expect(report.message).toContain("ready");
  });

  it("a token without schema scope gets the hand-build list, not a stack trace", async () => {
    const { impl, calls } = recorder([{ status: 403, body: { error: "NOT_AUTHORIZED" } }]);
    const report = await ensureAirtableSchema({ create: true }, { fetchImpl: impl });

    expect(report.ok).toBe(false);
    expect(report.configured).toBe(true);
    expect(report.readable).toBe(false);
    expect(report.changed).toBe(false);
    expect(report.message).toContain("schema.bases:read");
    for (const table of Object.keys(MIRROR_FIELD_SPEC)) {
      expect(report.message).toContain(table);
    }
    // MUST NOT FIRE: a denied read never proceeds to a write.
    expect(calls).toHaveLength(1);
  });

  it("survives a thrown fetch instead of taking the job down", async () => {
    const impl = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    const report = await ensureAirtableSchema({ create: true }, { fetchImpl: impl });
    expect(report.ok).toBe(false);
    expect(report.message).toContain("network down");
  });
});

describe("report-only mode", () => {
  beforeEach(() => Object.assign(env, CONFIG));

  it("MUST NOT FIRE: without create, it never POSTs", async () => {
    const { impl, calls } = recorder([{ body: { tables: [] } }]);
    const report = await ensureAirtableSchema({}, { fetchImpl: impl });

    expect(report.ok).toBe(false);
    expect(report.changed).toBe(false);
    expect(calls.filter((call) => call.method === "POST")).toEqual([]);
    expect(calls).toHaveLength(1);
    expect(report.message).toContain("missing table(s)");
    expect(report.details.missingTables).toEqual(Object.keys(MIRROR_FIELD_SPEC));
  });
});

describe("creating what is absent", () => {
  beforeEach(() => Object.assign(env, CONFIG));

  it("creates each missing table once, with its full field set", async () => {
    const { impl, calls } = recorder([{ body: { tables: [] } }]);
    const report = await ensureAirtableSchema({ create: true }, { fetchImpl: impl });

    expect(report.ok).toBe(true);
    expect(report.changed).toBe(true);

    const posts = calls.filter((call) => call.method === "POST");
    expect(posts).toHaveLength(Object.keys(MIRROR_FIELD_SPEC).length);
    expect(posts.map((call) => call.body?.name)).toEqual(Object.keys(MIRROR_FIELD_SPEC));

    for (const post of posts) {
      expect(post.url).toBe(`${AIRTABLE_META_BASE}/appTESTBASE/tables`);
      const fields = post.body?.fields as { name: string }[];
      const expected = MIRROR_FIELD_SPEC[String(post.body?.name)];
      expect(fields.map((field) => field.name)).toEqual(expected.map((field) => field.name));
      // The upsert key must exist or performUpsert 422s on every push.
      expect(fields.map((field) => field.name)).toContain(MERGE_FIELD);
    }
  });

  it("MUST NOT FIRE: a table it just created does not also get per-field POSTs", async () => {
    const { impl, calls } = recorder([{ body: { tables: [] } }]);
    await ensureAirtableSchema({ create: true }, { fetchImpl: impl });

    // Three table creates and nothing else. A /fields POST here would be the
    // duplicate-name 422 this guard exists to prevent.
    const fieldPosts = calls.filter((call) => call.url.includes("/fields"));
    expect(fieldPosts).toEqual([]);
  });

  it("adds a single missing column to an existing table, by table id", async () => {
    const base = completeBase();
    const speakers = base.tables.find((table) => table.name === "Speakers");
    speakers!.id = "tblSPEAKERS";
    speakers!.fields = speakers!.fields.filter((field) => field.name !== "Bio");

    const { impl, calls } = recorder([{ body: base }]);
    const report = await ensureAirtableSchema({ create: true }, { fetchImpl: impl });

    expect(report.ok).toBe(true);
    expect(report.details.createdFields).toEqual(["Speakers.Bio"]);

    const posts = calls.filter((call) => call.method === "POST");
    expect(posts).toHaveLength(1);
    expect(posts[0].url).toBe(`${AIRTABLE_META_BASE}/appTESTBASE/tables/tblSPEAKERS/fields`);
    expect(posts[0].body).toMatchObject({ name: "Bio", type: "multilineText" });
  });

  it("MUST NOT FIRE: a ready base is left completely alone", async () => {
    const { impl, calls } = recorder([{ body: completeBase() }]);
    const report = await ensureAirtableSchema({ create: true }, { fetchImpl: impl });

    expect(report.ok).toBe(true);
    expect(report.changed).toBe(false);
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("GET");
  });

  it("MUST NOT FIRE: it never issues a DELETE or a PATCH to the Metadata API", async () => {
    const base = completeBase();
    base.tables = base.tables.filter((table) => table.name !== "Submissions");
    const speakers = base.tables.find((table) => table.name === "Speakers");
    speakers!.fields = speakers!.fields.filter((field) => field.name !== "Bio");

    const { impl, calls } = recorder([{ body: base }]);
    await ensureAirtableSchema({ create: true }, { fetchImpl: impl });

    // NEGATIVE CONTROL: this run really did make requests, so the assertion
    // below is not passing vacuously.
    expect(calls.length).toBeGreaterThan(1);
    expect(calls.map((call) => call.method).sort()).toEqual(["GET", "POST", "POST"]);
  });

  it("reports a partial failure honestly instead of claiming success", async () => {
    const { impl } = recorder([
      { body: { tables: [] } },
      { status: 200 },
      { status: 422, body: { error: "INVALID_REQUEST" } },
      { status: 200 },
    ]);
    const report = await ensureAirtableSchema({ create: true }, { fetchImpl: impl });

    expect(report.ok).toBe(false);
    expect(report.changed).toBe(true);
    expect(report.details.createdTables).toHaveLength(2);
    expect((report.details.errors as string[])[0]).toContain("422");
  });
});

describe("reachable from the jobs registry", () => {
  it("is registered, and runs clean with no credentials", async () => {
    const { runJob, JOB_NAMES } = await import("~/lib/jobs/registry.server");
    expect(JOB_NAMES).toContain("airtable-schema");

    const result = await runJob("airtable-schema", { now: new Date(), trigger: "manual" });
    expect(result.ok).toBe(true);
    expect(result.message).toContain("not configured");
    expect(result.details).toMatchObject({ configured: false, trigger: "manual" });
  });

  it("has no cron — creating tables is an operator action, not a timer", async () => {
    const { JOBS } = await import("~/lib/jobs/registry.server");
    expect(JOBS["airtable-schema"].cron).toBeUndefined();
  });
});
