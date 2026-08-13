/**
 * The Airtable mirror: not-configured behaviour, batching, retries, and the
 * watermark that makes a failed run re-queue instead of losing rows.
 *
 * `fetch` is injected, so every assertion is about the request we would really
 * send — URL, verb, upsert key, batch size — rather than about a mock's shape.
 */
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { people, sessionParticipants, sessions, syncState } from "~/db/schema";
import { installTestDb, type TestDbContext } from "~/test/db";
import { seedDemoFixture, SPEAKERS, type DemoFixture } from "~/test/fixtures";
import { withStrictFetch } from "~/test/workerd-fetch";

import {
  AIRTABLE_BATCH_SIZE,
  AIRTABLE_MAX_ATTEMPTS,
  AIRTABLE_MERGE_FIELD,
  airtableConfig,
  collectMirrorPayload,
  runAirtableMirror,
} from "./airtable.server";
import { historyOf, readSyncState } from "./sync-state.server";

let ctx: TestDbContext;
let fixture: DemoFixture;

const CONFIG = { AIRTABLE_TOKEN: "pat_test_token", AIRTABLE_BASE: "appTESTBASE" };

interface Recorded {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: {
    records: { fields: Record<string, unknown> }[];
    typecast?: boolean;
    performUpsert?: { fieldsToMergeOn: string[] };
  };
}

function recorder(statuses: number[] = []) {
  const calls: Recorded[] = [];
  const impl = (async (input: unknown, init?: RequestInit) => {
    const headers = Object.fromEntries(
      Object.entries((init?.headers ?? {}) as Record<string, string>),
    );
    calls.push({
      url: String(input),
      method: init?.method ?? "GET",
      headers,
      body: JSON.parse(String(init?.body ?? "{}")),
    });
    const status = statuses[calls.length - 1] ?? 200;
    return new Response(status === 200 ? '{"records":[]}' : `{"error":"status ${status}"}`, {
      status,
    });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const sleeps: number[] = [];
const noSleep = async (ms: number) => {
  sleeps.push(ms);
};

beforeEach(async () => {
  sleeps.length = 0;
  ctx = installTestDb();
  fixture = await seedDemoFixture(ctx.db);
});
afterEach(() => ctx.close());

describe("not configured", () => {
  it("is a clean no-op, not an error", async () => {
    expect(airtableConfig()).toBeNull();

    const { impl, calls } = recorder();
    const result = await runAirtableMirror({ fetchImpl: impl, sleep: noSleep });

    expect(result.ok).toBe(true);
    expect(result.configured).toBe(false);
    expect(result.message).toContain("not configured");
    expect(calls).toHaveLength(0);
  });

  it("writes nothing to sync_state when it cannot run", async () => {
    await runAirtableMirror({ fetchImpl: recorder().impl, sleep: noSleep });
    const rows = await ctx.db.select().from(syncState);
    expect(rows).toHaveLength(0);
  });

  it("MUST NOT FIRE: half-configured is still off", async () => {
    ctx.close();
    ctx = installTestDb({ AIRTABLE_TOKEN: "pat_only" });
    await seedDemoFixture(ctx.db);
    expect(airtableConfig()).toBeNull();
    expect((await runAirtableMirror({ sleep: noSleep })).configured).toBe(false);
  });
});

describe("a configured run", () => {
  beforeEach(async () => {
    ctx.close();
    ctx = installTestDb(CONFIG);
    fixture = await seedDemoFixture(ctx.db);
  });

  it("pushes the three tables to the right URLs with an upsert key", async () => {
    const { impl, calls } = recorder();
    const result = await runAirtableMirror({ fetchImpl: impl, sleep: noSleep });

    expect(result.ok).toBe(true);
    expect(result.configured).toBe(true);

    // 8 speakers, 2 programme sessions, 8 abstracts — one batch each.
    expect(calls.map((call) => call.url)).toEqual([
      "https://api.airtable.com/v0/appTESTBASE/Speakers",
      "https://api.airtable.com/v0/appTESTBASE/Sessions",
      "https://api.airtable.com/v0/appTESTBASE/Submissions",
    ]);
    expect(calls.map((call) => call.body.records.length)).toEqual([8, 2, 8]);

    for (const call of calls) {
      expect(call.method).toBe("PATCH");
      expect(call.headers.authorization).toBe("Bearer pat_test_token");
      expect(call.body.typecast).toBe(true);
      expect(call.body.performUpsert).toEqual({
        fieldsToMergeOn: [AIRTABLE_MERGE_FIELD],
      });
      for (const record of call.body.records) {
        expect(typeof record.fields[AIRTABLE_MERGE_FIELD]).toBe("string");
      }
    }

    // Programme rows carry schedule fields; abstracts do not.
    const sessionRecord = calls[1].body.records[0].fields;
    expect(sessionRecord).toHaveProperty("Starts At");
    expect(sessionRecord).toHaveProperty("Room");
    expect(calls[2].body.records[0].fields).not.toHaveProperty("Starts At");
  });

  it("advances the watermark and records history", async () => {
    const now = new Date("2026-08-09T12:00:00.000Z");
    await runAirtableMirror({ fetchImpl: recorder().impl, sleep: noSleep, now });

    const state = await readSyncState(fixture.eventId, "airtable");
    expect(state?.lastError).toBeNull();
    expect(Number(state?.cursor)).toBeGreaterThan(0);

    const history = historyOf(state);
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ ok: true, action: "mirror" });
    expect(history[0].counts).toMatchObject({ speakers: 8, sessions: 2, submissions: 8 });
  });

  it("sends only what changed since the watermark", async () => {
    const first = recorder();
    await runAirtableMirror({ fetchImpl: first.impl, sleep: noSleep });
    const firstCount = first.calls.reduce((n, call) => n + call.body.records.length, 0);
    expect(firstCount).toBe(18); // 8 speakers + 2 sessions + 8 submissions

    // A second run re-sends only the boundary rows (see the `>=` note in
    // collectMirrorPayload) — never the whole event again.
    const second = recorder();
    await runAirtableMirror({ fetchImpl: second.impl, sleep: noSleep });
    const secondCount = second.calls.reduce((n, call) => n + call.body.records.length, 0);
    expect(secondCount).toBeLessThan(firstCount);

    // Touch one row well past the watermark; it is the only NEW thing that goes.
    const future = new Date(Date.now() + 60_000);
    await ctx.db
      .update(sessions)
      .set({ title: "Renamed after the mirror ran", updatedAt: future })
      .where(eq(sessions.id, fixture.programSessionIds[0]));

    const third = recorder();
    await runAirtableMirror({ fetchImpl: third.impl, sleep: noSleep });
    const titles = third.calls
      .filter((call) => call.url.endsWith("/Sessions"))
      .flatMap((call) => call.body.records.map((record) => record.fields.Title));
    expect(titles).toContain("Renamed after the mirror ran");

    // …and the fourth run, past that watermark, has nothing left to say.
    const fourth = recorder();
    await runAirtableMirror({ fetchImpl: fourth.impl, sleep: noSleep });
    const fourthCount = fourth.calls.reduce((n, call) => n + call.body.records.length, 0);
    expect(fourthCount).toBeLessThanOrEqual(1);
  });

  it("MUST FIRE: a row written in the SAME instant as the watermark is not lost", async () => {
    await runAirtableMirror({ fetchImpl: recorder().impl, sleep: noSleep });
    const watermark = Number(
      (await readSyncState(fixture.eventId, "airtable"))?.cursor,
    );
    expect(watermark).toBeGreaterThan(0);

    /*
     * The bug this guards: timestamps default to `unixepoch() * 1000`, so rows
     * routinely SHARE a millisecond. A strict `>` watermark would skip this row
     * on every future run and it would never reach Airtable at all.
     */
    await ctx.db.insert(sessions).values({
      eventId: fixture.eventId,
      title: "Written on the watermark boundary",
      status: "accepted",
      isAbstract: false,
      updatedAt: new Date(watermark),
    });

    const next = recorder();
    await runAirtableMirror({ fetchImpl: next.impl, sleep: noSleep });
    const titles = next.calls.flatMap((call) =>
      call.body.records.map((record) => record.fields.Title),
    );
    expect(titles).toContain("Written on the watermark boundary");
  });

  it("splits anything over 10 records into Airtable-sized batches", async () => {
    const extra = Array.from({ length: 11 }, (_, index) => ({
      eventId: fixture.eventId,
      title: `Filler session ${index}`,
      status: "accepted" as const,
      isAbstract: false,
    }));
    await ctx.db.insert(sessions).values(extra);

    const { impl, calls } = recorder();
    await runAirtableMirror({ fetchImpl: impl, sleep: noSleep });

    const sessionCalls = calls.filter((call) => call.url.endsWith("/Sessions"));
    // 2 seeded + 11 filler = 13 -> 10 + 3.
    expect(sessionCalls.map((call) => call.body.records.length)).toEqual([
      AIRTABLE_BATCH_SIZE,
      3,
    ]);
  });
});

describe("failure handling", () => {
  beforeEach(async () => {
    ctx.close();
    ctx = installTestDb(CONFIG);
    fixture = await seedDemoFixture(ctx.db);
  });

  it("retries a 429 with backoff and then succeeds", async () => {
    // First Speakers attempt 429s, the retry works; the other two tables are fine.
    const { impl, calls } = recorder([429, 200, 200, 200]);
    const result = await runAirtableMirror({ fetchImpl: impl, sleep: noSleep });

    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(4);
    expect(calls[0].url).toBe(calls[1].url);
    expect(sleeps[0]).toBe(250);
  });

  it("gives up after the attempt cap and keeps the rows queued", async () => {
    const { impl, calls } = recorder([429, 429, 429, 200, 200]);
    const result = await runAirtableMirror({ fetchImpl: impl, sleep: noSleep });

    expect(result.ok).toBe(false);
    expect(calls.filter((call) => call.url.endsWith("/Speakers"))).toHaveLength(
      AIRTABLE_MAX_ATTEMPTS,
    );

    const state = await readSyncState(fixture.eventId, "airtable");
    // MUST NOT FIRE: a failed run does not advance the watermark, so the same
    // speakers are retried next tick instead of being silently dropped.
    expect(state?.cursor ?? null).toBeNull();
    expect(state?.lastError).toContain("Speakers");
  });

  it("does NOT retry a permanent 4xx — that just burns the rate limit", async () => {
    const { impl, calls } = recorder([422, 200, 200]);
    const result = await runAirtableMirror({ fetchImpl: impl, sleep: noSleep });

    expect(result.ok).toBe(false);
    expect(calls.filter((call) => call.url.endsWith("/Speakers"))).toHaveLength(1);
    expect(sleeps).toHaveLength(0);
  });

  it("survives a thrown fetch without taking the whole job down", async () => {
    const impl = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    const result = await runAirtableMirror({ fetchImpl: impl, sleep: noSleep });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("queued");
  });
});

describe("reachable from the jobs route", () => {
  it("runs through the registry, which is the only way cron is ever tested", async () => {
    const { runJob, JOB_NAMES } = await import("~/lib/jobs/registry.server");
    expect(JOB_NAMES).toContain("airtable-mirror");

    const result = await runJob("airtable-mirror", { now: new Date(), trigger: "manual" });
    expect(result.ok).toBe(true);
    expect(result.message).toContain("not configured");
    expect(result.details).toMatchObject({ configured: false, trigger: "manual" });
  });

  it("never throws out of the registry — a failing job reports, it does not crash cron", async () => {
    // `runJob` catches, but a job that throws would surface as ok:false with a
    // "threw" message. Prove the mirror's own failure path is the reported one.
    const { runJob } = await import("~/lib/jobs/registry.server");
    const result = await runJob("airtable-mirror", { now: new Date(), trigger: "cron" });
    expect(result.message).not.toContain("threw");
  });
});

describe("payload shaping", () => {
  it("splits abstracts from programme sessions and joins speaker names", async () => {
    const payload = await collectMirrorPayload(fixture.eventId, 0);
    expect(payload.speakers).toHaveLength(8);
    expect(payload.sessions).toHaveLength(2);
    expect(payload.submissions).toHaveLength(8);

    const first = payload.sessions[0].fields;
    // The roster column is display NAMES. It used to be `toContain("@")` —
    // that assertion passed on a payload that put contact addresses into the
    // table an organizer shares by link. See "PII containment" below.
    expect(first.Speakers).toEqual(expect.any(String));
    expect(String(first.Speakers)).not.toContain("@");
    expect(payload.watermark).toBeGreaterThan(0);
  });

  it("returns nothing when the watermark is already ahead", async () => {
    const payload = await collectMirrorPayload(fixture.eventId, Date.now() + 3_600_000);
    expect(payload.speakers).toHaveLength(0);
    expect(payload.sessions).toHaveLength(0);
    expect(payload.submissions).toHaveLength(0);
  });
});

/**
 * PII containment — bound to the TABLE, and bound to the VALUE.
 *
 * `airtable-projection.test.ts` scans the mirror's source for column names. It
 * is the right guard for "a new field appeared", and it is structurally blind
 * to the two mutations that leak without adding one:
 *
 *   1. an APPROVED column on the WRONG TABLE. That scan flattens all three
 *      tables into a single name set, so `Bio` or `Email` moved onto `Sessions`
 *      reuses an approved name and stays green.
 *   2. an approved column whose EXPRESSION changed. It never reads the right
 *      hand side, so `Bio: row.bio` -> `Bio: someSecret` stays green, and so
 *      did `Speakers` joining contact addresses — which is what shipped: all
 *      three mirrored tables carried email while the spec promised one did.
 *
 * Both are checked here instead, against the real payload rather than against
 * source text. The allowlist below is written out BY HAND rather than imported
 * from `MIRROR_FIELD_SPEC`: partly because two independent lists are the point
 * of an allowlist, and partly because `airtable-projection.test.ts` pins the
 * modules allowed to import the preflight and this file is not one of them.
 */
describe("PII containment", () => {
  const PER_TABLE_COLUMNS: Record<"speakers" | "sessions" | "submissions", string[]> = {
    speakers: ["Callboard ID", "Email", "Name", "Company", "Title", "Bio", "Updated At"],
    sessions: [
      "Callboard ID",
      "Reference",
      "Title",
      "Status",
      "Track",
      "Speakers",
      "Room",
      "Starts At",
      "Ends At",
      "Public",
      "Updated At",
    ],
    submissions: ["Callboard ID", "Reference", "Title", "Status", "Track", "Speakers", "Updated At"],
  };

  /** Every column name the payload actually puts on one table. */
  const columnsOf = (records: { fields: Record<string, unknown> }[]) =>
    [...new Set(records.flatMap((record) => Object.keys(record.fields)))].sort();

  /** The display names the DB says belong on a session, in insertion order. */
  async function namesForSession(sessionId: string): Promise<string[]> {
    const rows = await ctx.db
      .select({ fullName: people.fullName, email: people.email })
      .from(sessionParticipants)
      .innerJoin(people, eq(people.id, sessionParticipants.personId))
      .where(eq(sessionParticipants.sessionId, sessionId));
    return rows.map((row) => row.fullName?.trim() || row.email.split("@")[0]);
  }

  it("MUST FIRE: no column reaches a table it was not approved for", async () => {
    const payload = await collectMirrorPayload(fixture.eventId, 0);

    for (const table of ["speakers", "sessions", "submissions"] as const) {
      const seen = columnsOf(payload[table]);
      expect(seen.length, table).toBeGreaterThan(4); // not vacuous
      expect(
        seen.filter((column) => !PER_TABLE_COLUMNS[table].includes(column)),
        `unapproved column on ${table}`,
      ).toEqual([]);
    }
  });

  it("MUST FIRE: the table binding rejects an approved name on the wrong table", async () => {
    // The control for the check above. `Email` and `Bio` are approved columns —
    // on `Speakers`. The flattened name scan cannot tell them apart from the
    // same names landing on `Sessions`; this can, and must.
    const planted = [{ fields: { "Callboard ID": "x", Title: "t", Email: "a@b.c", Bio: "…" } }];
    expect(
      columnsOf(planted).filter((column) => !PER_TABLE_COLUMNS.sessions.includes(column)),
    ).toEqual(["Bio", "Email"]);
  });

  it("MUST FIRE: no email address reaches the session tables at all", async () => {
    // Red on the unfixed tree: `Sessions.Speakers` and `Submissions.Speakers`
    // were `people.email` comma-joined, typed `multilineText` so the base did
    // not even show them as an email column.
    const payload = await collectMirrorPayload(fixture.eventId, 0);

    for (const table of ["sessions", "submissions"] as const) {
      for (const record of payload[table]) {
        for (const [column, value] of Object.entries(record.fields)) {
          expect(String(value ?? ""), `${table}.${column}`).not.toContain("@");
        }
      }
    }
  });

  it("MUST STILL FIRE: the Speakers TABLE keeps its addresses", async () => {
    // The complement. A "fix" that stripped email everywhere would pass every
    // assertion above and break the one thing the mirror exists to carry.
    const payload = await collectMirrorPayload(fixture.eventId, 0);
    expect(payload.speakers.length).toBeGreaterThan(0);
    for (const record of payload.speakers) {
      expect(String(record.fields.Email)).toContain("@");
    }
    expect(payload.speakers.map((record) => record.fields.Email)).toContain(
      "speaker@callboard.dev",
    );
  });

  it("pins the roster column to the names the database holds", async () => {
    // Value equality, not shape: this is what makes an expression swap red.
    const payload = await collectMirrorPayload(fixture.eventId, 0);
    const rostered = [...payload.sessions, ...payload.submissions].filter(
      (record) => String(record.fields.Speakers ?? "") !== "",
    );
    expect(rostered.length).toBeGreaterThan(0);

    for (const record of rostered) {
      const expected = await namesForSession(String(record.fields[AIRTABLE_MERGE_FIELD]));
      expect(record.fields.Speakers).toBe(expected.join(", "));
      // And the names really are names — a fallback that returned the address
      // would satisfy the line above by matching itself.
      for (const name of expected) expect(SPEAKERS.map((s) => s.name)).toContain(name);
    }
  });

  it("pins every speaker column to its own source row", async () => {
    // Catches the second blind spot named above: an approved column keeping its
    // NAME while its expression changes (`Bio: row.bio` -> `Bio: someSecret`).
    const payload = await collectMirrorPayload(fixture.eventId, 0);
    const record = payload.speakers.find(
      (candidate) => candidate.fields.Email === "speaker@callboard.dev",
    );
    expect(record).toBeDefined();

    const row = await ctx.db.query.people.findFirst({
      where: eq(people.email, "speaker@callboard.dev"),
    });
    expect(record?.fields).toEqual({
      [AIRTABLE_MERGE_FIELD]: row!.id,
      Email: row!.email,
      Name: row!.fullName,
      Company: row!.company,
      Title: row!.title,
      Bio: row!.bio,
      "Updated At": row!.updatedAt.toISOString(),
    });
  });

  it("falls back to the email local-part, never the address, when a name is absent", async () => {
    // `people.full_name` is nullable even though the seed and both fixtures
    // always set it. A nameless row must degrade to "rina", not to
    // "rina@example.com" — otherwise the leak returns through the back door.
    await ctx.db
      .update(people)
      .set({ fullName: null })
      .where(eq(people.email, "rina@example.com"));

    const payload = await collectMirrorPayload(fixture.eventId, 0);
    const joined = [...payload.sessions, ...payload.submissions]
      .map((record) => String(record.fields.Speakers ?? ""))
      .join(" | ");

    expect(joined).toContain("rina");
    expect(joined).not.toContain("rina@example.com");
    expect(joined).not.toContain("@");
  });
});

describe("workerd receiver enforcement", () => {
  it("MUST FIRE: the default fetch path never calls the platform fetch with a foreign `this` (workerd Illegal invocation)", async () => {
    ctx.close();
    ctx = installTestDb(CONFIG);
    await seedDemoFixture(ctx.db);
    await withStrictFetch(async (calls) => {
      const result = await runAirtableMirror({ sleep: noSleep });
      expect(calls.length).toBeGreaterThan(0);
      expect(JSON.stringify(result)).not.toContain("Illegal invocation");
    }, () => new Response(JSON.stringify({ records: [] }), { status: 200 }));
  });
});
