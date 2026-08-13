/**
 * `/v1` end-to-end through the REAL route handlers, against a real SQLite D1
 * stand-in with the real migrations applied.
 *
 * Not a mock in sight: the key is minted with `mintApiKey`, presented in the
 * `x-access-token` header, and resolved by the same middleware a deployed
 * request hits. A test that stubs the auth module proves the handler runs, not
 * that it is protected.
 *
 * Every guard gets both halves: the 401 that must fire without a key, and the
 * 200 the SAME request produces with one.
 */
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { sessions } from "~/db/schema";
import { mintApiKey, type ApiScope } from "~/lib/api/keys.server";
import { installTestDb, type TestDbContext } from "~/test/db";
import { seedDemoFixture, type DemoFixture } from "~/test/fixtures";

import { loader as eventsLoader } from "./v1.events";
import { action as searchAction, loader as searchLoader } from "./v1.sessions";
import { action as createAction } from "./v1.sessions.create";
import { action as bulkAction } from "./v1.sessions.bulk";
import { action as sessionAction, loader as sessionLoader } from "./v1.session";
import { action as restoreAction } from "./v1.session.restore";
import { action as speakersAction } from "./v1.speakers";
import { loader as speakerLoader } from "./v1.speaker";
import { action as metadataAction, loader as metadataLoader } from "./v1.metadata";
import { action as metadataCreateAction } from "./v1.metadata.create";
import { loader as openapiLoader } from "./v1.openapi";

let ctx: TestDbContext;
let fixture: DemoFixture;
let readKey: string;
let writeKey: string;

const ORIGIN = "https://callboard.test";

beforeEach(async () => {
  ctx = installTestDb();
  fixture = await seedDemoFixture(ctx.db);
  readKey = (
    await mintApiKey({
      eventId: fixture.eventId,
      name: "read-only",
      scopes: ["read:events", "read:sessions", "read:contacts", "read:metadata"],
    })
  ).plaintext;
  writeKey = (
    await mintApiKey({
      eventId: fixture.eventId,
      name: "read-write",
      scopes: [
        "read:events",
        "read:sessions",
        "write:sessions",
        "read:contacts",
        "read:metadata",
        "write:metadata",
      ],
    })
  ).plaintext;
});

afterEach(() => ctx.close());

/* ------------------------------------------------------------- helpers */

type Handler = (args: {
  request: Request;
  params: Record<string, string>;
  context: unknown;
}) => Promise<unknown>;

/** Run a handler and normalise "threw a Response" into "returned a Response". */
async function call(
  handler: Handler,
  request: Request,
  params: Record<string, string> = {},
): Promise<Response> {
  try {
    const result = await handler({ request, params, context: {} });
    if (result instanceof Response) return result;
    throw new Error(`Handler returned a non-Response: ${JSON.stringify(result)}`);
  } catch (thrown) {
    if (thrown instanceof Response) return thrown;
    throw thrown;
  }
}

function request(
  method: string,
  path: string,
  options: { key?: string; body?: unknown } = {},
): Request {
  const headers: Record<string, string> = {};
  if (options.key) headers["x-access-token"] = options.key;
  if (options.body !== undefined) headers["content-type"] = "application/json";
  return new Request(`${ORIGIN}${path}`, {
    method,
    headers,
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
}

/*
 * Response bodies are dynamic JSON. Typing them loosely is deliberate: the
 * assertions below ARE the type check, and a hand-written interface here would
 * only prove that the interface matches itself.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type JsonBody = Record<string, any>;

async function json(response: Response): Promise<JsonBody> {
  return (await response.json()) as JsonBody;
}

const eventPath = (suffix = "") => `/v1/event/${fixture.eventId}${suffix}`;

async function search(body: unknown, key = readKey): Promise<JsonBody> {
  const response = await call(
    searchAction as Handler,
    request("POST", eventPath("/sessions/search"), { key, body }),
    { eventId: fixture.eventId },
  );
  expect(response.status).toBe(200);
  return json(response);
}

/* ---------------------------------------------------------------- auth */

describe("authentication", () => {
  it("MUST FIRE: 401 without a key, on every collection", async () => {
    const cases: [Handler, Request, Record<string, string>][] = [
      [eventsLoader as Handler, request("GET", "/v1/events"), {}],
      [
        searchAction as Handler,
        request("POST", eventPath("/sessions/search"), { body: {} }),
        { eventId: fixture.eventId },
      ],
      [
        createAction as Handler,
        request("POST", eventPath("/sessions/create"), { body: { title: "x" } }),
        { eventId: fixture.eventId },
      ],
      [
        metadataLoader as Handler,
        request("GET", eventPath("/tracks")),
        { eventId: fixture.eventId },
      ],
      [
        speakersAction as Handler,
        request("POST", eventPath("/speakers/search"), { body: {} }),
        { eventId: fixture.eventId },
      ],
    ];

    for (const [handler, req, params] of cases) {
      const response = await call(handler, req, params);
      expect(response.status, `${req.method} ${new URL(req.url).pathname}`).toBe(401);
      const body = await json(response);
      expect(body.error).toBe("UnauthorizedError");
    }
  });

  it("MUST NOT FIRE: the same requests succeed with a key", async () => {
    const events = await call(eventsLoader as Handler, request("GET", "/v1/events", { key: readKey }));
    expect(events.status).toBe(200);

    const tracks = await call(
      metadataLoader as Handler,
      request("GET", eventPath("/tracks"), { key: readKey }),
      { eventId: fixture.eventId },
    );
    expect(tracks.status).toBe(200);

    const speakers = await call(
      speakersAction as Handler,
      request("POST", eventPath("/speakers/search"), { key: readKey, body: {} }),
      { eventId: fixture.eventId },
    );
    expect(speakers.status).toBe(200);
  });

  it("401s an unknown key and a REVOKED key alike", async () => {
    const unknown = await call(
      eventsLoader as Handler,
      request("GET", "/v1/events", { key: "cb_totally-made-up" }),
    );
    expect(unknown.status).toBe(401);

    const doomed = await mintApiKey({
      eventId: fixture.eventId,
      name: "temp",
      scopes: ["read:events"],
    });
    const before = await call(
      eventsLoader as Handler,
      request("GET", "/v1/events", { key: doomed.plaintext }),
    );
    expect(before.status).toBe(200);

    const { revokeApiKey } = await import("~/lib/api/keys.server");
    await revokeApiKey(fixture.eventId, doomed.key.id);

    const after = await call(
      eventsLoader as Handler,
      request("GET", "/v1/events", { key: doomed.plaintext }),
    );
    expect(after.status).toBe(401);
  });

  it("accepts `Authorization: Bearer` as an alias for x-access-token", async () => {
    const response = await call(
      eventsLoader as Handler,
      new Request(`${ORIGIN}/v1/events`, {
        headers: { authorization: `Bearer ${readKey}` },
      }),
    );
    expect(response.status).toBe(200);
  });

  it("403s a key minted for another event", async () => {
    const other = await ctx.db
      .insert((await import("~/db/schema")).events)
      .values({ name: "Other event", slug: "other-event" })
      .returning();
    const otherKey = await mintApiKey({
      eventId: other[0].id,
      name: "other",
      scopes: ["read:sessions"],
    });

    const response = await call(
      searchAction as Handler,
      request("POST", eventPath("/sessions/search"), { key: otherKey.plaintext, body: {} }),
      { eventId: fixture.eventId },
    );
    expect(response.status).toBe(403);
    expect((await json(response)).error).toBe("ForbiddenError");
  });

  it("403s a read-only key on a write, and scopes do NOT cascade", async () => {
    const create = await call(
      createAction as Handler,
      request("POST", eventPath("/sessions/create"), {
        key: readKey,
        body: { title: "Should not exist" },
      }),
      { eventId: fixture.eventId },
    );
    expect(create.status).toBe(403);

    // read:metadata does not grant write:metadata.
    const metaCreate = await call(
      metadataCreateAction as Handler,
      request("POST", eventPath("/tracks/create"), { key: readKey, body: { name: "Nope" } }),
      { eventId: fixture.eventId },
    );
    expect(metaCreate.status).toBe(403);

    // …and the same call with the write key works, so the 403 was the scope.
    const allowed = await call(
      metadataCreateAction as Handler,
      request("POST", eventPath("/tracks/create"), { key: writeKey, body: { name: "Nope" } }),
      { eventId: fixture.eventId },
    );
    expect(allowed.status).toBe(201);
  });

  it("405s the wrong verb with an `allow` header", async () => {
    const response = await call(
      searchLoader as Handler,
      request("GET", eventPath("/sessions"), { key: readKey }),
      { eventId: fixture.eventId },
    );
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("POST");
  });
});

/* ------------------------------------------------------------ envelope */

describe("the one envelope (DECISIONS #5)", () => {
  it("GET /v1/events returns {results, pagination} with the key's event", async () => {
    const response = await call(
      eventsLoader as Handler,
      request("GET", "/v1/events", { key: readKey }),
    );
    const body = await json(response);
    expect(Object.keys(body).sort()).toEqual(["pagination", "results"]);
    expect(body.pagination).toEqual({
      currentPage: 1,
      pageSize: 25,
      totalPages: 1,
      totalResults: 1,
    });
    const [event] = body.results as unknown as { id: string; slug: string }[];
    expect(event.id).toBe(fixture.eventId);
    expect(event.slug).toBe("frontier-ai-summit-2026");
  });

  it("never uses the `data` key Sessionboard's CRUD proxy returns", async () => {
    const bodies: JsonBody[] = [
      await json(
        await call(eventsLoader as Handler, request("GET", "/v1/events", { key: readKey })),
      ),
      await search({}),
      await json(
        await call(
          metadataLoader as Handler,
          request("GET", eventPath("/tracks"), { key: readKey }),
          { eventId: fixture.eventId },
        ),
      ),
      await json(
        await call(
          speakersAction as Handler,
          request("POST", eventPath("/speakers/search"), { key: readKey, body: {} }),
          { eventId: fixture.eventId },
        ),
      ),
    ];
    for (const body of bodies) {
      expect(body).toHaveProperty("results");
      expect(body).toHaveProperty("pagination");
      expect(body).not.toHaveProperty("data");
      expect(Object.keys(body.pagination).sort()).toEqual([
        "currentPage",
        "pageSize",
        "totalPages",
        "totalResults",
      ]);
    }
  });

  it("pages by exact values, and clamps a silly pageSize instead of 400ing", async () => {
    const all = await search({ filters: { is_abstract: true } });
    expect(all.pagination).toEqual({
      currentPage: 1,
      pageSize: 25,
      totalPages: 1,
      totalResults: 8,
    });

    const paged = await search({ filters: { is_abstract: true }, pageSize: 3, page: 2 });
    expect(paged.pagination).toEqual({
      currentPage: 2,
      pageSize: 3,
      totalPages: 3,
      totalResults: 8,
    });
    expect((paged.results as unknown as unknown[]).length).toBe(3);

    const clamped = await search({ pageSize: 5000, page: -4 });
    expect(clamped.pagination.pageSize).toBe(100);
    expect(clamped.pagination.currentPage).toBe(1);
  });

  it("an empty result set is ONE page, not zero", async () => {
    const empty = await search({ filters: { text: "no session is called this" } });
    expect(empty.results).toEqual([]);
    expect(empty.pagination).toMatchObject({ totalResults: 0, totalPages: 1 });
  });
});

/* -------------------------------------------------------------- search */

describe("session search", () => {
  it("filters by is_abstract, status, track and text with exact counts", async () => {
    expect((await search({ filters: { is_abstract: true } })).pagination.totalResults).toBe(8);
    expect((await search({ filters: { is_abstract: false } })).pagination.totalResults).toBe(2);
    expect(
      (await search({ filters: { status: ["accepted"] } })).pagination.totalResults,
    ).toBe(4); // 2 abstracts + the 2 sessions composed from them
    expect(
      (await search({ filters: { status: "accepted", is_abstract: true } })).pagination
        .totalResults,
    ).toBe(2);
    // 3 abstracts on track 0 (indices 0, 3, 6) plus programme session SESS-1.
    expect((await search({ filters: { track: "Agents" } })).pagination.totalResults).toBe(4);
    expect(
      (await search({ filters: { text: "guardrails" } })).pagination.totalResults,
    ).toBe(1);
  });

  it("accepts camelCase AND snake_case filter keys", async () => {
    const snake = await search({ filters: { is_abstract: true } });
    const camel = await search({ filters: { isAbstract: true } });
    expect(camel.pagination.totalResults).toBe(snake.pagination.totalResults);
  });

  it("MUST NOT FIRE: a LIKE wildcard in the text filter is not a match-everything", async () => {
    const literal = await search({ filters: { text: "%" } });
    expect(literal.pagination.totalResults).toBe(0);
  });

  it("sorts by title, which Sessionboard's API cannot do", async () => {
    const body = await search({
      filters: { is_abstract: true },
      sort: { order: "title", sort: "asc" },
    });
    const titles = (body.results as unknown as { title: string }[]).map((row) => row.title);
    expect(titles).toEqual([...titles].sort());
  });

  it("serializes a session in the documented shape", async () => {
    const body = await search({ filters: { is_abstract: false } });
    const rows = body.results as unknown as Record<string, unknown>[];
    const composed = rows.find((row) => row.id === fixture.programSessionIds[0])!;

    expect(composed.is_abstract).toBe(false);
    expect(composed.friendly_id).toBe("SESS-1");
    expect(composed.starts_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect((composed.track as { name: string }).name).toBe("Agents");
    expect((composed.room as { name: string }).name).toBe("Main Stage");
    // Unassigned metadata is null, never {} (their §8.3 inconsistency, fixed).
    expect(composed.level).toBeNull();
    expect(composed.admin_url).toBe(`${ORIGIN}/admin/agenda`);

    const participants = composed.participants as { email: string; participant_role: { slug: string; core_role: string } }[];
    expect(participants.map((p) => p.email)).toEqual(["speaker@callboard.dev"]);
    expect(participants[0].participant_role).toEqual({
      slug: "speaker",
      name: "Speaker",
      core_role: "speaker",
    });

    // This row is the composition TARGET of an accepted abstract.
    expect(composed.composition_status).toMatchObject({
      role: "target",
      is_linked: true,
      source_count: 1,
    });
  });

  it("reports the abstract side of a composition as `source`", async () => {
    const response = await call(
      sessionLoader as Handler,
      request("GET", eventPath(`/sessions/${fixture.abstractIds[0]}`), { key: readKey }),
      { eventId: fixture.eventId, sessionId: fixture.abstractIds[0] },
    );
    const body = await json(response);
    expect(body.composition_status).toMatchObject({
      role: "source",
      is_linked: true,
      // We do NOT copy their read-only dead-end (§8.8).
      is_read_only: false,
    });
    expect(
      (body.composition_status as unknown as { target: { id: string } }).target.id,
    ).toBe(fixture.programSessionIds[0]);
  });

  it("embeds tags, and returns [] rather than null when there are none", async () => {
    const { sessionTags, tags } = await import("~/db/schema");
    const [tag] = await ctx.db
      .insert(tags)
      .values({ eventId: fixture.eventId, name: "production", order: 0 })
      .returning();
    await ctx.db
      .insert(sessionTags)
      .values({ sessionId: fixture.abstractIds[0], tagId: tag.id });

    const tagged = await json(
      await call(
        sessionLoader as Handler,
        request("GET", eventPath(`/sessions/${fixture.abstractIds[0]}`), { key: readKey }),
        { eventId: fixture.eventId, sessionId: fixture.abstractIds[0] },
      ),
    );
    expect((tagged.tags as { name: string }[]).map((row) => row.name)).toEqual([
      "production",
    ]);

    const untagged = await json(
      await call(
        sessionLoader as Handler,
        request("GET", eventPath(`/sessions/${fixture.abstractIds[1]}`), { key: readKey }),
        { eventId: fixture.eventId, sessionId: fixture.abstractIds[1] },
      ),
    );
    expect(untagged.tags).toEqual([]);
  });

  it("returns CFP answers as sorted custom_fields", async () => {
    const response = await call(
      sessionLoader as Handler,
      request("GET", eventPath(`/sessions/${fixture.abstractIds[0]}`), { key: readKey }),
      { eventId: fixture.eventId, sessionId: fixture.abstractIds[0] },
    );
    const fields = (await json(response)).custom_fields as unknown as {
      key: string;
      value: unknown;
    }[];
    const keys = fields.map((field) => field.key);
    expect(keys).toEqual([...keys].sort());
    expect(keys).toContain("legacy_note");
  });

  it("404s a session from another event rather than leaking it", async () => {
    const response = await call(
      sessionLoader as Handler,
      request("GET", eventPath("/sessions/00000000-0000-4000-8000-000000000000"), {
        key: readKey,
      }),
      { eventId: fixture.eventId, sessionId: "00000000-0000-4000-8000-000000000000" },
    );
    expect(response.status).toBe(404);
  });
});

/* -------------------------------------------------------------- writes */

describe("create / update / delete / restore", () => {
  async function create(body: unknown, key = writeKey) {
    return call(
      createAction as Handler,
      request("POST", eventPath("/sessions/create"), { key, body }),
      { eventId: fixture.eventId },
    );
  }

  it("creates an abstract and gives it a friendly id", async () => {
    const response = await create({
      title: "Evals that predict production failures",
      is_abstract: true,
      description: "<p>Body.</p>",
    });
    expect(response.status).toBe(201);
    const body = await json(response);
    expect(body.title).toBe("Evals that predict production failures");
    expect(body.is_abstract).toBe(true);
    expect(body.status).toBe("pending");
    expect(body.friendly_id).toBe("ABS-9");

    const after = await search({ filters: { is_abstract: true } });
    expect(after.pagination.totalResults).toBe(9);
  });

  it("rejects a create with no title", async () => {
    const response = await create({ description: "no title" });
    expect(response.status).toBe(400);
    expect((await json(response)).message).toContain("`title` is required");
  });

  it("updates, and 409s on a stale updated_at", async () => {
    const id = fixture.abstractIds[3];
    const read = await json(
      await call(
        sessionLoader as Handler,
        request("GET", eventPath(`/sessions/${id}`), { key: readKey }),
        { eventId: fixture.eventId, sessionId: id },
      ),
    );

    const fresh = await call(
      sessionAction as Handler,
      request("PUT", eventPath(`/sessions/${id}`), {
        key: writeKey,
        body: { status: "accept_queue", updated_at: read.updated_at },
      }),
      { eventId: fixture.eventId, sessionId: id },
    );
    expect(fresh.status).toBe(200);
    expect((await json(fresh)).status).toBe("accept_queue");

    // The guard is millisecond-precise: a value one ms off is already stale.
    const offByOne = await call(
      sessionAction as Handler,
      request("PUT", eventPath(`/sessions/${id}`), {
        key: writeKey,
        body: {
          status: "accepted",
          updated_at: new Date(Date.parse(read.updated_at) + 1).toISOString(),
        },
      }),
      { eventId: fixture.eventId, sessionId: id },
    );
    expect(offByOne.status).toBe(409);

    // The row moved on; the ORIGINAL updated_at is now stale.
    const stale = await call(
      sessionAction as Handler,
      request("PUT", eventPath(`/sessions/${id}`), {
        key: writeKey,
        body: { status: "accepted", updated_at: read.updated_at },
      }),
      { eventId: fixture.eventId, sessionId: id },
    );
    expect(stale.status).toBe(409);
    expect((await json(stale)).error).toBe("ConflictError");

    // MUST NOT FIRE: omitting updated_at forces the write instead of 409ing.
    const forced = await call(
      sessionAction as Handler,
      request("PUT", eventPath(`/sessions/${id}`), {
        key: writeKey,
        body: { status: "accepted" },
      }),
      { eventId: fixture.eventId, sessionId: id },
    );
    expect(forced.status).toBe(200);
  });

  it("refuses to flip is_abstract on update", async () => {
    const id = fixture.abstractIds[0];
    const response = await call(
      sessionAction as Handler,
      request("PUT", eventPath(`/sessions/${id}`), {
        key: writeKey,
        body: { is_abstract: false },
      }),
      { eventId: fixture.eventId, sessionId: id },
    );
    expect(response.status).toBe(400);
    expect((await json(response)).message).toContain("immutable");

    const row = await ctx.db.query.sessions.findFirst({ where: eq(sessions.id, id) });
    expect(row?.isAbstract).toBe(true);
  });

  it("rejects an end before its start", async () => {
    const response = await create({
      title: "Backwards",
      starts_at: "2026-09-15T18:00:00.000Z",
      ends_at: "2026-09-15T17:00:00.000Z",
    });
    expect(response.status).toBe(400);
    expect((await json(response)).message).toContain("`ends_at` must be after");
  });

  it("soft-deletes, hides from search, and restores", async () => {
    const id = fixture.abstractIds[4];

    const deleted = await call(
      sessionAction as Handler,
      request("DELETE", eventPath(`/sessions/${id}`), { key: writeKey }),
      { eventId: fixture.eventId, sessionId: id },
    );
    expect(deleted.status).toBe(200);
    expect((await json(deleted)).deleted_at).toMatch(/^\d{4}-/);

    // The ROW is still there — soft, not gone.
    const row = await ctx.db.query.sessions.findFirst({ where: eq(sessions.id, id) });
    expect(row).toBeTruthy();
    expect(row?.deletedAt).not.toBeNull();

    expect((await search({ filters: { is_abstract: true } })).pagination.totalResults).toBe(7);
    expect(
      (await search({ filters: { is_abstract: true, include_deleted: true } })).pagination
        .totalResults,
    ).toBe(8);

    const restored = await call(
      restoreAction as Handler,
      request("POST", eventPath(`/sessions/${id}/restore`), { key: writeKey }),
      { eventId: fixture.eventId, sessionId: id },
    );
    expect(restored.status).toBe(200);
    expect((await json(restored)).deleted_at).toBeNull();
    expect((await search({ filters: { is_abstract: true } })).pagination.totalResults).toBe(8);
  });

  it("404s a restore of a session that was never deleted", async () => {
    const response = await call(
      restoreAction as Handler,
      request("POST", eventPath(`/sessions/${fixture.abstractIds[0]}/restore`), {
        key: writeKey,
      }),
      { eventId: fixture.eventId, sessionId: fixture.abstractIds[0] },
    );
    expect(response.status).toBe(404);
  });
});

/* ---------------------------------------------------------------- bulk */

describe("bulk", () => {
  async function bulk(body: unknown, key = writeKey) {
    return call(
      bulkAction as Handler,
      request("POST", eventPath("/sessions/bulk"), { key, body }),
      { eventId: fixture.eventId },
    );
  }

  it("reports PARTIAL success: one good row lands, one bad row is named", async () => {
    const response = await bulk({
      operations: [
        { action: "create", data: { title: "Lightning: tool-calling traps" } },
        { action: "update", id: "00000000-0000-4000-8000-000000000000", data: { status: "accepted" } },
      ],
    });
    expect(response.status).toBe(200);

    const body = await json(response);
    expect(body.stats).toEqual({ total: 2, succeeded: 1, failed: 1 });
    expect(typeof body.batch_id).toBe("string");

    const results = body.results as unknown as {
      index: number;
      action: string;
      status: string;
      id?: string;
      error?: { code: string; message: string };
    }[];
    expect(results[0]).toMatchObject({ index: 0, action: "create", status: "success" });
    expect(typeof results[0].id).toBe("string");
    expect(results[1]).toMatchObject({ index: 1, action: "update", status: "error" });
    expect(results[1].error?.code).toBe("not_found");

    // The good row is really there — partial success is not "reported success".
    const created = await ctx.db.query.sessions.findFirst({
      where: eq(sessions.title, "Lightning: tool-calling traps"),
    });
    expect(created).toBeTruthy();
  });

  it("rejects more than 100 operations, and an empty batch", async () => {
    const tooMany = await bulk({
      operations: Array.from({ length: 101 }, () => ({
        action: "create",
        data: { title: "x" },
      })),
    });
    expect(tooMany.status).toBe(400);
    expect((await json(tooMany)).message).toContain("100");

    const empty = await bulk({ operations: [] });
    expect(empty.status).toBe(400);
  });

  it("accepts exactly 100 — the boundary is inclusive", async () => {
    const response = await bulk({
      operations: Array.from({ length: 100 }, (_, index) => ({
        action: "create",
        data: { title: `Bulk ${index}` },
      })),
    });
    expect(response.status).toBe(200);
    expect((await json(response)).stats).toEqual({
      total: 100,
      succeeded: 100,
      failed: 0,
    });
  });

  it("names an unknown action instead of silently skipping it", async () => {
    const response = await bulk({ operations: [{ action: "upsert", data: {} }] });
    const results = (await json(response)).results as unknown as {
      error?: { message: string };
    }[];
    expect(results[0].error?.message).toContain("Unknown action");
  });
});

/* ------------------------------------------------------------ metadata */

describe("metadata families through ONE handler", () => {
  const families = ["tracks", "rooms", "tags", "formats", "levels"] as const;

  it("lists every family from the same handler, keyed off the path", async () => {
    const counts: Record<string, number> = {};
    for (const family of families) {
      const response = await call(
        metadataLoader as Handler,
        request("GET", eventPath(`/${family}`), { key: readKey }),
        { eventId: fixture.eventId },
      );
      expect(response.status, family).toBe(200);
      counts[family] = (await json(response)).pagination.totalResults;
    }
    // Exact values from the fixture — a shape assertion would pass on zeros.
    expect(counts).toEqual({ tracks: 3, rooms: 3, tags: 0, formats: 3, levels: 0 });
  });

  it("emits the family-specific column and omits the ones that do not apply", async () => {
    const tracks = await json(
      await call(
        metadataLoader as Handler,
        request("GET", eventPath("/tracks"), { key: readKey }),
        { eventId: fixture.eventId },
      ),
    );
    const track = (tracks.results as unknown as Record<string, unknown>[])[0];
    expect(track.color).toBe("#329af0");
    expect(track).not.toHaveProperty("capacity");
    expect(track.event_id).toBe(fixture.eventId);

    const rooms = await json(
      await call(
        metadataLoader as Handler,
        request("GET", eventPath("/rooms"), { key: readKey }),
        { eventId: fixture.eventId },
      ),
    );
    const room = (rooms.results as unknown as Record<string, unknown>[])[0];
    expect(room.capacity).toBe(800);
    expect(room).not.toHaveProperty("color");
  });

  it("searches by text over POST", async () => {
    const response = await call(
      metadataAction as Handler,
      request("POST", eventPath("/tracks"), {
        key: readKey,
        body: { filters: { text: "Infra" } },
      }),
      { eventId: fixture.eventId },
    );
    const body = await json(response);
    expect(body.pagination.totalResults).toBe(1);
    expect((body.results as unknown as { name: string }[])[0].name).toBe("Infrastructure");
  });

  it("creates, and refuses a duplicate name with a real message", async () => {
    const created = await call(
      metadataCreateAction as Handler,
      request("POST", eventPath("/rooms/create"), {
        key: writeKey,
        body: { name: "Workshop Room 3", capacity: 60 },
      }),
      { eventId: fixture.eventId },
    );
    expect(created.status).toBe(201);
    expect((await json(created)).capacity).toBe(60);

    const duplicate = await call(
      metadataCreateAction as Handler,
      request("POST", eventPath("/rooms/create"), {
        key: writeKey,
        body: { name: "Workshop Room 3" },
      }),
      { eventId: fixture.eventId },
    );
    expect(duplicate.status).toBe(400);
    expect((await json(duplicate)).message).toContain("already exists");
  });

  it("does not invent a capacity on a family that has no such column", async () => {
    const response = await call(
      metadataCreateAction as Handler,
      request("POST", eventPath("/tags/create"), {
        key: writeKey,
        body: { name: "hardware", capacity: 99 },
      }),
      { eventId: fixture.eventId },
    );
    expect(response.status).toBe(201);
    expect(await json(response)).not.toHaveProperty("capacity");
  });
});

/* ------------------------------------------------------------ speakers */

describe("speakers", () => {
  it("returns contacts for everyone on a live session, and nobody else", async () => {
    const response = await call(
      speakersAction as Handler,
      request("POST", eventPath("/speakers/search"), { key: readKey, body: {} }),
      { eventId: fixture.eventId },
    );
    const body = await json(response);
    // 8 seeded speakers are all participants; the admin is not.
    expect(body.pagination.totalResults).toBe(8);
    const emails = (body.results as unknown as { email: string }[]).map((row) => row.email);
    expect(emails).not.toContain("admin@callboard.dev");
  });

  it("filters by text and returns the Sessionboard contact shape", async () => {
    const response = await call(
      speakersAction as Handler,
      request("POST", eventPath("/speakers/search"), {
        key: readKey,
        body: { filters: { text: "okafor" } },
      }),
      { eventId: fixture.eventId },
    );
    const [speaker] = (await json(response)).results as unknown as Record<string, unknown>[];
    expect(speaker.email).toBe("rina@example.com");
    expect(speaker.full_name).toBe("Rina Okafor");
    // Sessionboard names the bio `about` and the org `company_name`.
    expect(speaker).toHaveProperty("about");
    expect(speaker).toHaveProperty("company_name");
    expect(speaker.photo_url).toBeNull();
  });

  it("returns one speaker with the sessions they are on", async () => {
    const response = await call(
      speakerLoader as Handler,
      request("GET", eventPath(`/speakers/${fixture.speakerIds[0]}`), { key: readKey }),
      { eventId: fixture.eventId, contactId: fixture.speakerIds[0] },
    );
    expect(response.status).toBe(200);
    const body = await json(response);
    expect(body.email).toBe("speaker@callboard.dev");
    const ids = body.session_ids as unknown as string[];
    expect(ids).toContain(fixture.abstractIds[0]);
    expect(ids).toContain(fixture.programSessionIds[0]);
  });

  it("404s the admin, who is not a speaker on anything", async () => {
    const response = await call(
      speakerLoader as Handler,
      request("GET", eventPath(`/speakers/${fixture.adminId}`), { key: readKey }),
      { eventId: fixture.eventId, contactId: fixture.adminId },
    );
    expect(response.status).toBe(404);
  });
});

/* ------------------------------------------------------------- openapi */

describe("openapi.json", () => {
  it("is served unauthenticated and describes the shipped endpoints", async () => {
    const response = await call(openapiLoader as Handler, new Request(`${ORIGIN}/v1/openapi.json`));
    expect(response.status).toBe(200);

    const spec = await json(response);
    expect(spec.openapi).toBe("3.1.0");
    const paths = spec.paths as unknown as Record<string, Record<string, unknown>>;
    expect(paths["/v1/events"]).toHaveProperty("get");
    expect(paths["/v1/event/{eventId}/sessions/search"]).toHaveProperty("post");
    expect(paths["/v1/event/{eventId}/sessions/{sessionId}"]).toHaveProperty("put");
    expect(paths["/v1/event/{eventId}/sessions/{sessionId}"]).toHaveProperty("delete");
    // The compatibility alias is documented, not just tolerated.
    expect(paths["/v1/event/{eventId}/sessions"]).toHaveProperty("post");

    const schemes = (spec.components as unknown as { securitySchemes: Record<string, { name: string }> })
      .securitySchemes;
    expect(schemes.ApiKeyAuth.name).toBe("x-access-token");
  });
});

/* ------------------------------------------------------------- cache headers */

/*
 * REGRESSION TEST for GitHub issue #201 (blindspot audit). Fixed at the
 * shared layer, `apiJson()` (app/lib/api/envelope.ts) — the ONE response
 * builder every `/v1` route uses (GET, POST, PUT, DELETE and errors alike) —
 * which used to set only `content-type`, no `cache-control`. These routes
 * return private, mutable, per-key-scoped D1 data (events, sessions,
 * speakers, metadata), authenticated primarily via the CUSTOM
 * `x-access-token` header (app/lib/api/auth.server.ts:18) rather than
 * standard `Authorization` — so a generic shared cache did not get RFC
 * 9111's built-in "don't store a response to an Authorization-bearing
 * request" protection for the primary auth path; only the `Authorization:
 * Bearer` alias would have gotten that for free.
 *
 * Cloudflare's Worker-level HTTP cache is disabled in this repo today
 * (wrangler.jsonc declares no cache rules, and nothing in app/ calls the
 * Cache API — confirmed separately during this audit), so the practical
 * blast radius was limited to intermediary proxies applying HTTP heuristic
 * freshness. But nothing was stopping a future edge-cache rule, a
 * misconfigured reverse proxy in front of a self-hosted deployment, or a
 * client-side HTTP cache from serving one key's cached response to a request
 * that presents a DIFFERENT (including revoked) key hitting the same URL.
 *
 * `apiJson()` now defaults `cache-control` to `private, no-store` (matching
 * the house convention at app/routes/admin.files.download.ts) for every
 * caller; a route with a legitimate reason to differ can still override it
 * via its own `headers` argument — v1.openapi.ts does exactly that to stay
 * `public, max-age=300`, since it's unauthenticated and safe to cache.
 */
describe("cache headers on authenticated /v1 GET routes", () => {
  it("every authenticated GET response sets cache-control: private, no-store (#201)", async () => {
    const cases: [string, Handler, Request, Record<string, string>][] = [
      ["GET /v1/events", eventsLoader as Handler, request("GET", "/v1/events", { key: readKey }), {}],
      [
        "GET /v1/event/:id/sessions/:sessionId",
        sessionLoader as Handler,
        request("GET", eventPath(`/sessions/${fixture.abstractIds[0]}`), { key: readKey }),
        { eventId: fixture.eventId, sessionId: fixture.abstractIds[0] },
      ],
      [
        "GET /v1/event/:id/speakers/:contactId",
        speakerLoader as Handler,
        request("GET", eventPath(`/speakers/${fixture.speakerIds[0]}`), { key: readKey }),
        { eventId: fixture.eventId, contactId: fixture.speakerIds[0] },
      ],
      [
        "GET /v1/event/:id/tracks",
        metadataLoader as Handler,
        request("GET", eventPath("/tracks"), { key: readKey }),
        { eventId: fixture.eventId },
      ],
    ];

    for (const [label, handler, req, params] of cases) {
      const response = await call(handler, req, params);
      expect(response.status, label).toBe(200);
      expect(response.headers.get("cache-control"), label).toBe("private, no-store");
    }
  });
});
