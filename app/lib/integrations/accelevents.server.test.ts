/**
 * The Accelevents surface against the real database: what the CSV pair contains
 * when built from seeded rows, and what the optional API push actually sends.
 *
 * The byte-level contract lives in accelevents-csv.test.ts. This file checks
 * the half that needs a DB: which rows are selected, how participants map onto
 * their Primary/Secondary columns, and that the push uses their header name,
 * their date format, and their API enum — not the CSV one.
 */
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { sessionParticipants, sessions } from "~/db/schema";
import { installTestDb, type TestDbContext } from "~/test/db";
import { seedDemoFixture, type DemoFixture } from "~/test/fixtures";

import {
  ACCELEVENTS_AUTH_HEADER,
  ACCELEVENTS_DUPLICATE_EMAIL_CODE,
  accelConfig,
  buildAccelCsvPair,
  loadAccelExportData,
  pushToAccelevents,
  recordCsvGeneration,
} from "./accelevents.server";
import { ACCELEVENTS_SESSION_COLUMNS } from "./accelevents-csv";
import { historyOf, readSyncState } from "./sync-state.server";

let ctx: TestDbContext;
let fixture: DemoFixture;

const CRLF = "\r\n";
const CONFIG = { apiKey: "ae_test_key", eventUrl: "frontier-ai-summit" };
const noSleep = async () => {};

beforeEach(async () => {
  ctx = installTestDb();
  fixture = await seedDemoFixture(ctx.db);
});
afterEach(() => ctx.close());

describe("what gets exported", () => {
  it("exports the PROGRAMME and its people, not the CFP backlog", async () => {
    const data = await loadAccelExportData(fixture.eventId);
    // 2 programme sessions in the fixture; the 8 abstracts stay out.
    expect(data.sessions).toHaveLength(2);
    expect(data.speakers.map((speaker) => speaker.email)).toEqual([
      "rina@example.com",
      "speaker@callboard.dev",
    ]);
    expect(data.timeZone).toBe("America/Los_Angeles");
  });

  it("builds both halves of the pair with matching emails", async () => {
    const pair = await buildAccelCsvPair(fixture.eventId);

    expect(pair.speakers.filename).toBe("speakers.csv");
    expect(pair.sessions.filename).toBe("sessions.csv");
    expect(pair.speakers.rowCount).toBe(2);
    expect(pair.sessions.rowCount).toBe(2);

    const sessionRows = pair.sessions.csv.split(CRLF).filter(Boolean).slice(1);
    const secondaryIndex = ACCELEVENTS_SESSION_COLUMNS.indexOf("Secondary Speaker");
    const formatIndex = ACCELEVENTS_SESSION_COLUMNS.indexOf("Format");
    const locationIndex = ACCELEVENTS_SESSION_COLUMNS.indexOf("Location ID");

    for (const row of sessionRows) {
      const cells = row.split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/);
      expect(cells[formatIndex]).toBe("REGULAR_SESSION");
      // Rooms start at 2; 1 is reserved for unassigned.
      expect(Number(cells[locationIndex])).toBeGreaterThanOrEqual(2);
      // Every email in the session file must exist in the speaker file — that
      // linkage by email IS the integration.
      const emails = cells[secondaryIndex].replace(/^"|"$/g, "").split(",").filter(Boolean);
      expect(emails.length).toBeGreaterThan(0);
      for (const email of emails) expect(pair.speakers.csv).toContain(email);
    }
  });

  it("puts moderators in Primary and everyone else in Secondary", async () => {
    await ctx.db
      .update(sessionParticipants)
      .set({ role: "moderator" })
      .where(eq(sessionParticipants.sessionId, fixture.programSessionIds[0]));

    const pair = await buildAccelCsvPair(fixture.eventId);
    const primaryIndex = ACCELEVENTS_SESSION_COLUMNS.indexOf("Primary Speaker");
    const secondaryIndex = ACCELEVENTS_SESSION_COLUMNS.indexOf("Secondary Speaker");

    const rows = pair.sessions.csv
      .split(CRLF)
      .filter(Boolean)
      .slice(1)
      .map((row) => row.split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/));

    const moderated = rows.find((cells) => cells[primaryIndex] !== "")!;
    expect(moderated[primaryIndex]).toBe("speaker@callboard.dev");
    expect(moderated[secondaryIndex]).toBe("");
  });

  it("carries session tags into the Tags column, quoted when there are several", async () => {
    const { sessionTags, tags } = await import("~/db/schema");
    const rows = await ctx.db
      .insert(tags)
      .values([
        { eventId: fixture.eventId, name: "oss", order: 0 },
        { eventId: fixture.eventId, name: "production", order: 1 },
      ])
      .returning();
    await ctx.db.insert(sessionTags).values(
      rows.map((tag) => ({ sessionId: fixture.programSessionIds[0], tagId: tag.id })),
    );

    const pair = await buildAccelCsvPair(fixture.eventId);
    const tagIndex = ACCELEVENTS_SESSION_COLUMNS.indexOf("Tags");
    const cells = pair.sessions.csv
      .split(CRLF)
      .filter(Boolean)
      .slice(1)
      .map((row) => row.split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/));

    expect(cells.some((row) => row[tagIndex] === '"oss,production"')).toBe(true);
    // MUST NOT FIRE: an untagged session gets an empty cell, not the other
    // session's tags.
    expect(cells.some((row) => row[tagIndex] === "")).toBe(true);
  });

  it("reports an unscheduled session instead of emitting a row their importer rejects", async () => {
    await ctx.db
      .update(sessions)
      .set({ startsAt: null, endsAt: null })
      .where(eq(sessions.id, fixture.programSessionIds[1]));

    const pair = await buildAccelCsvPair(fixture.eventId);
    expect(pair.sessions.rowCount).toBe(1);
    expect(pair.sessions.skipped).toHaveLength(1);
    expect(pair.sessions.skipped[0].reason).toContain("Start Date");
  });

  it("flags the blank cells that would DELETE data on a re-import", async () => {
    const pair = await buildAccelCsvPair(fixture.eventId);
    // Seeded speakers have a bio, company and title but no socials or pronouns.
    const warned = pair.speakers.blankCells.find(
      (row) => row.email === "rina@example.com",
    )!;
    expect(warned.columns).toContain("Pronouns");
    expect(warned.columns).toContain("Instagram");
    expect(warned.columns).not.toContain("Company");
    expect(warned.columns).not.toContain("Bio");
  });

  it("renders an empty event without throwing", async () => {
    const [empty] = await ctx.db
      .insert((await import("~/db/schema")).events)
      .values({ name: "Empty", slug: "empty" })
      .returning();

    const pair = await buildAccelCsvPair(empty.id);
    expect(pair.speakers.rowCount).toBe(0);
    expect(pair.sessions.rowCount).toBe(0);
    // Header only, still terminated.
    expect(pair.speakers.csv.split(CRLF).filter(Boolean)).toHaveLength(1);
  });
});

describe("sync history", () => {
  it("records a CSV generation so the panel has something to show", async () => {
    const pair = await buildAccelCsvPair(fixture.eventId);
    await recordCsvGeneration(fixture.eventId, pair, new Date("2026-08-09T09:00:00.000Z"));

    const state = await readSyncState(fixture.eventId, "accelevents");
    const history = historyOf(state);
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ ok: true, action: "csv-pair" });
    expect(history[0].message).toContain("speakers.csv (2 rows)");
    expect(state?.lastSyncedAt?.toISOString()).toBe("2026-08-09T09:00:00.000Z");
  });

  it("keeps the newest run first and caps the list", async () => {
    const pair = await buildAccelCsvPair(fixture.eventId);
    for (let i = 0; i < 12; i += 1) {
      await recordCsvGeneration(
        fixture.eventId,
        pair,
        new Date(Date.UTC(2026, 7, 9, 9, i)),
      );
    }
    const history = historyOf(await readSyncState(fixture.eventId, "accelevents"));
    expect(history).toHaveLength(10);
    expect(history[0].at).toBe("2026-08-09T09:11:00.000Z");
  });
});

describe("configuration", () => {
  it("is null unless BOTH the key and their event slug are set", async () => {
    expect(accelConfig()).toBeNull();

    ctx.close();
    ctx = installTestDb({ ACCELEVENTS_API_KEY: "k" });
    expect(accelConfig()).toBeNull();

    ctx.close();
    ctx = installTestDb({ ACCELEVENTS_API_KEY: "k", ACCELEVENTS_EVENT_URL: "slug" });
    expect(accelConfig()).toEqual({ apiKey: "k", eventUrl: "slug" });
  });
});

describe("the optional API push", () => {
  interface Recorded {
    url: string;
    method: string;
    headers: Record<string, string>;
    body: Record<string, unknown>;
  }

  function recorder(responder: (call: number, url: string) => Response) {
    const calls: Recorded[] = [];
    const impl = (async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      calls.push({
        url,
        method: init?.method ?? "GET",
        headers: { ...((init?.headers ?? {}) as Record<string, string>) },
        body: JSON.parse(String(init?.body ?? "{}")),
      });
      return responder(calls.length, url);
    }) as unknown as typeof fetch;
    return { impl, calls };
  }

  const ok = () => new Response("12", { status: 200 });

  it("uses their `Key` header, their URL shape, and their API date format", async () => {
    const { impl, calls } = recorder(ok);
    const result = await pushToAccelevents({
      eventId: fixture.eventId,
      config: CONFIG,
      fetchImpl: impl,
      sleep: noSleep,
    });

    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(4); // 2 speakers + 2 sessions

    for (const call of calls) {
      expect(call.method).toBe("POST");
      expect(call.headers[ACCELEVENTS_AUTH_HEADER]).toBe("ae_test_key");
      expect(call.url.startsWith("https://api.accelevents.com/rest/host/event/frontier-ai-summit/")).toBe(
        true,
      );
    }

    const sessionCalls = calls.filter((call) => call.url.endsWith("/session"));
    expect(sessionCalls).toHaveLength(2);
    for (const call of sessionCalls) {
      expect(call.body.sessionTypeFormat).toBe("IN_PERSON");
      // MUST FIRE: the API vocabulary, not the CSV one.
      expect(call.body.format).toBe("BREAKOUT_SESSION");
      // MUST NOT FIRE: the CSV value must never reach the API.
      expect(call.body.format).not.toBe("REGULAR_SESSION");
      expect(call.body.startTime).toMatch(/^\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}$/);
    }
  });

  it("MUST NOT FIRE: no speaker id is ever attached to a session body", async () => {
    const { impl, calls } = recorder(ok);
    await pushToAccelevents({
      eventId: fixture.eventId,
      config: CONFIG,
      fetchImpl: impl,
      sleep: noSleep,
    });

    // Not an oversight — their API has no field for it (§5). If a future
    // version adds one, this test is where the omission stops being correct.
    for (const call of calls.filter((c) => c.url.endsWith("/session"))) {
      const keys = Object.keys(call.body).join(" ").toLowerCase();
      expect(keys).not.toContain("speaker");
    }
    expect(
      (await pushToAccelevents({
        eventId: fixture.eventId,
        config: CONFIG,
        fetchImpl: recorder(ok).impl,
        sleep: noSleep,
      })).message,
    ).toContain("Speaker↔session links still require the CSV pair");
  });

  it("treats their duplicate-email error as an upsert, not a failure", async () => {
    const { impl } = recorder((call, url) =>
      url.endsWith("/speaker") && call === 1
        ? new Response(
            JSON.stringify({
              errorCode: ACCELEVENTS_DUPLICATE_EMAIL_CODE,
              message: "Speaker already exist with same email.",
            }),
            { status: 400 },
          )
        : ok(),
    );

    const result = await pushToAccelevents({
      eventId: fixture.eventId,
      config: CONFIG,
      fetchImpl: impl,
      sleep: noSleep,
    });

    expect(result.ok).toBe(true);
    expect(result.counts.speakersExisting).toBe(1);
    expect(result.counts.speakersCreated).toBe(1);
    expect(result.counts.failed).toBe(0);
  });

  it("MUST FIRE: a genuine error is counted and surfaced", async () => {
    const { impl } = recorder((_, url) =>
      url.endsWith("/session")
        ? new Response('{"message":"Bad session"}', { status: 500 })
        : ok(),
    );

    const result = await pushToAccelevents({
      eventId: fixture.eventId,
      config: CONFIG,
      fetchImpl: impl,
      sleep: noSleep,
    });

    expect(result.ok).toBe(false);
    expect(result.counts.failed).toBe(2);
    expect(result.errors[0]).toContain("500");

    const state = await readSyncState(fixture.eventId, "accelevents");
    expect(state?.lastError).toContain("failed");
    expect(historyOf(state)[0].ok).toBe(false);
  });

  it("throttles between requests, because their limits are undocumented", async () => {
    const waits: number[] = [];
    await pushToAccelevents({
      eventId: fixture.eventId,
      config: CONFIG,
      fetchImpl: recorder(ok).impl,
      sleep: async (ms) => {
        waits.push(ms);
      },
    });
    expect(waits).toHaveLength(4);
    expect(new Set(waits)).toEqual(new Set([1000]));
  });
});
