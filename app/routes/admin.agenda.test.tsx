/**
 * Agenda builder: loader values, the scheduling action (must-fire AND
 * must-not-fire), and every one of the six views rendering with seed rows and
 * with zero rows.
 *
 * The render assertions run the REAL exported view through
 * `renderToStaticMarkup` — the screen is deliberately router-free, so these are
 * page renders, not snapshots of loader data.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { gateOverrides, sessions } from "~/db/schema";
import { signedInGet, signedInPost } from "~/test/auth";
import { installTestDb, type TestDbContext } from "~/test/db";
import { seedDemoFixture, type DemoFixture } from "~/test/fixtures";

import AdminAgenda, { AgendaScreen, action, loader, parseView } from "./admin.agenda";
import type { AgendaData } from "./admin.agenda";

type LoaderArgs = Parameters<typeof loader>[0];
type ActionArgs = Parameters<typeof action>[0];

const asLoaderArgs = (request: Request) =>
  ({ request, params: {}, context: {} }) as unknown as LoaderArgs;
const asActionArgs = (request: Request) =>
  ({ request, params: {}, context: {} }) as unknown as ActionArgs;

const BASE = "https://x.test/admin/agenda";

let ctx: TestDbContext;
let fixture: DemoFixture;

beforeEach(async () => {
  ctx = installTestDb();
  fixture = await seedDemoFixture(ctx.db);
});
afterEach(() => ctx.close());

async function load(url = BASE): Promise<AgendaData> {
  return loader(asLoaderArgs(await signedInGet(url, fixture.adminId)));
}

async function post(fields: Record<string, string>) {
  return action(asActionArgs(await signedInPost(BASE, fixture.adminId, fields)));
}

/**
 * An unscheduled programme session — the state the agenda exists to resolve.
 * Created here rather than in `scripts/seed.mjs`, which another lane owns.
 */
async function addUnscheduled(title = "Sponsor keynote: Vectorly"): Promise<string> {
  const id = `unsch-${title.length}-0000-4000-8000-000000000001`;
  await ctx.db.insert(sessions).values({
    id,
    eventId: fixture.eventId,
    friendlyId: `SESS-${title.length}`,
    title,
    status: "accepted",
    isAbstract: false,
    trackId: fixture.trackIds[0],
    isPublic: false,
  });
  return id;
}

/** The seeded programme sessions sit at 10:00 and 11:00 UTC on 2026-10-07. */
const DAY_ONE = "2026-10-07";

describe("parseView", () => {
  it("accepts the six views and falls back to list", () => {
    for (const view of ["list", "day", "week", "track", "room", "conflicts"]) {
      expect(parseView(view)).toBe(view);
    }
    expect(parseView("month")).toBe("list");
    expect(parseView(null)).toBe("list");
    expect(parseView(undefined)).toBe("list");
  });
});

describe("loader", () => {
  it("reports the seeded programme with exact counts", async () => {
    const data = await load();

    expect(data.counts).toEqual({
      total: 2,
      scheduled: 2,
      unscheduled: 0,
      published: 2,
      conflicts: 0,
    });
    // Abstracts are NOT programme sessions and must never reach the agenda.
    expect(data.rows.map((row) => row.title)).toEqual([
      "Shipping agents that survive contact with users",
      "Evals that actually predict production failures",
    ]);
  });

  it("resolves rooms, tracks, speakers and event-local day/time on each row", async () => {
    const data = await load();
    const row = data.rows[0];

    expect(row.roomName).toBe("Main Stage");
    expect(row.trackName).toBe("Agents");
    expect(row.speakers).toEqual(["Sam Speaker"]);
    expect(row.day).toBe(DAY_ONE);
    // 2026-10-07T22:00Z is 3 PM in Los Angeles — the EVENT's timezone.
    expect(row.time).toBe("15:00");
    expect(row.durationMinutes).toBe(30);
    expect(row.rangeLabel).toBe("3:00 PM – 3:30 PM");
  });

  it("lists the three event days and defaults to the first", async () => {
    const data = await load();
    expect(data.days).toEqual(["2026-10-07", "2026-10-08", "2026-10-09"]);
    expect(data.day).toBe(DAY_ONE);
  });

  it("honours ?day= for a real day and ignores a bogus one", async () => {
    expect((await load(`${BASE}?view=day&day=2026-10-09`)).day).toBe("2026-10-09");
    expect((await load(`${BASE}?view=day&day=1999-01-01`)).day).toBe(DAY_ONE);
    expect((await load(`${BASE}?view=day&day=garbage`)).day).toBe(DAY_ONE);
  });

  it("puts an unscheduled programme session in the unscheduled count", async () => {
    await addUnscheduled();
    const data = await load();

    expect(data.counts.total).toBe(3);
    expect(data.counts.unscheduled).toBe(1);
    const row = data.rows.find((r) => r.title === "Sponsor keynote: Vectorly");
    expect(row?.startsAt).toBeNull();
    expect(row?.day).toBeNull();
    expect(row?.rangeLabel).toBe("Unscheduled");
    // Falls back to the default length so the schedule form is pre-filled.
    expect(row?.durationMinutes).toBe(30);
  });

  it("returns an empty shell when no event exists", async () => {
    const empty = installTestDb();
    try {
      const data = await loader(
        asLoaderArgs(new Request(BASE, { headers: { cookie: "" } })),
      ).catch((thrown) => thrown);
      // requireAdmin rejects an anonymous request — that IS the guard working.
      expect(data).toBeInstanceOf(Response);
    } finally {
      empty.close();
    }
  });
});

describe("action: schedule (the JS-off round-trip and the drop target)", () => {
  it("MUST FIRE: moves a session to a room, day and time", async () => {
    const target = fixture.programSessionIds[1];

    const response = (await post({
      intent: "schedule",
      sessionId: target,
      roomId: fixture.roomIds[2],
      day: "2026-10-08",
      time: "09:30",
      durationMinutes: "45",
      view: "day",
      returnDay: DAY_ONE,
    })) as Response;

    expect(response.status).toBe(302);

    const row = await ctx.db.query.sessions.findFirst({ where: eq(sessions.id, target) });
    expect(row?.roomId).toBe(fixture.roomIds[2]);
    // 9:30 AM PDT on 2026-10-08 is 16:30 UTC.
    expect(row?.startsAt?.toISOString()).toBe("2026-10-08T16:30:00.000Z");
    expect(row?.endsAt?.toISOString()).toBe("2026-10-08T17:15:00.000Z");

    // …and the loader now shows it on the new day.
    const data = await load();
    const moved = data.rows.find((r) => r.id === target);
    expect(moved?.day).toBe("2026-10-08");
    expect(moved?.time).toBe("09:30");
    expect(moved?.roomName).toBe("Workshop Room 2");
  });

  it("MUST FIRE: schedules a previously unscheduled session", async () => {
    const target = await addUnscheduled();
    expect((await load()).counts.unscheduled).toBe(1);

    await post({
      intent: "schedule",
      sessionId: target,
      roomId: fixture.roomIds[1],
      day: "2026-10-09",
      time: "13:00",
      durationMinutes: "60",
      view: "list",
    });

    const data = await load();
    expect(data.counts.unscheduled).toBe(0);
    expect(data.counts.scheduled).toBe(3);
  });

  it("MUST FIRE: a session can be moved with NO room", async () => {
    const target = fixture.programSessionIds[0];
    await post({
      intent: "schedule",
      sessionId: target,
      roomId: "",
      day: DAY_ONE,
      time: "16:00",
      durationMinutes: "30",
      view: "list",
    });
    const row = await ctx.db.query.sessions.findFirst({ where: eq(sessions.id, target) });
    expect(row?.roomId).toBeNull();
    expect(row?.startsAt).not.toBeNull();
  });

  it("MUST NOT FIRE: a malformed day, time or duration leaves the row untouched", async () => {
    const target = fixture.programSessionIds[0];
    const before = await ctx.db.query.sessions.findFirst({ where: eq(sessions.id, target) });

    const bad: Record<string, string>[] = [
      { day: "2026-10-7", time: "09:00", durationMinutes: "30" },
      { day: "nonsense", time: "09:00", durationMinutes: "30" },
      { day: DAY_ONE, time: "9:00", durationMinutes: "30" },
      { day: DAY_ONE, time: "24:00", durationMinutes: "30" },
      { day: DAY_ONE, time: "09:00", durationMinutes: "0" },
      { day: DAY_ONE, time: "09:00", durationMinutes: "721" },
      { day: DAY_ONE, time: "09:00", durationMinutes: "12.5" },
    ];

    for (const fields of bad) {
      const result = await post({
        intent: "schedule",
        sessionId: target,
        roomId: fixture.roomIds[0],
        view: "list",
        ...fields,
      });
      expect(result, JSON.stringify(fields)).toMatchObject({ ok: false });
    }

    const after = await ctx.db.query.sessions.findFirst({ where: eq(sessions.id, target) });
    expect(after?.startsAt?.toISOString()).toBe(before?.startsAt?.toISOString());
    expect(after?.endsAt?.toISOString()).toBe(before?.endsAt?.toISOString());
  });

  it("MUST NOT FIRE: an ABSTRACT cannot be dropped onto the agenda", async () => {
    const abstractId = fixture.abstractIds[3];
    const result = await post({
      intent: "schedule",
      sessionId: abstractId,
      roomId: fixture.roomIds[0],
      day: DAY_ONE,
      time: "09:00",
      durationMinutes: "30",
      view: "list",
    });

    expect(result).toMatchObject({ ok: false });
    const row = await ctx.db.query.sessions.findFirst({ where: eq(sessions.id, abstractId) });
    expect(row?.startsAt).toBeNull();
  });

  it("MUST NOT FIRE: an unknown session id, or a room from another event", async () => {
    expect(
      await post({
        intent: "schedule",
        sessionId: "no-such-session",
        day: DAY_ONE,
        time: "09:00",
        durationMinutes: "30",
      }),
    ).toMatchObject({ ok: false });

    const result = await post({
      intent: "schedule",
      sessionId: fixture.programSessionIds[0],
      roomId: "room-from-another-event",
      day: DAY_ONE,
      time: "09:00",
      durationMinutes: "30",
    });
    expect(result).toMatchObject({ ok: false });
  });

  it("MUST NOT FIRE: an unknown intent", async () => {
    expect(await post({ intent: "drop-database" })).toMatchObject({ ok: false });
  });
});

describe("action: a blocking placement is refused; forcing it warns (DECISIONS #70)", () => {
  /**
   * Park session B on top of session A: same room, same half hour.
   *
   * This is a ROOM double-booking, which #70 classes as blocking, so the move
   * only lands with `force`. The unforced case is the test directly below.
   */
  async function createOverlap() {
    return (await post({
      intent: "schedule",
      sessionId: fixture.programSessionIds[1],
      roomId: fixture.roomIds[0], // Main Stage — where session 0 already sits
      day: DAY_ONE,
      time: "15:00", // exactly session 0's slot
      durationMinutes: "30",
      view: "day",
      returnDay: DAY_ONE,
      force: "1",
      reason: "The room owner approved the overlap.",
    })) as Response;
  }

  it("MUST FIRE: an UNFORCED move into an occupied room is refused and nothing moves", async () => {
    const before = await ctx.db.query.sessions.findFirst({
      where: eq(sessions.id, fixture.programSessionIds[1]),
    });

    const result = (await post({
      intent: "schedule",
      sessionId: fixture.programSessionIds[1],
      roomId: fixture.roomIds[0],
      day: DAY_ONE,
      time: "15:00",
      durationMinutes: "30",
      view: "day",
      returnDay: DAY_ONE,
    })) as { ok: false; error: string; blocked: { reasons: string[] } };

    expect(result.ok).toBe(false);
    expect(result.error).toContain("Room double-booked · Main Stage");
    expect(result.blocked.reasons.join(" ")).toContain("Main Stage");

    // The refusal is real: the row is byte-for-byte where it started.
    const after = await ctx.db.query.sessions.findFirst({
      where: eq(sessions.id, fixture.programSessionIds[1]),
    });
    expect(after?.roomId).toBe(before?.roomId);
    expect(after?.startsAt?.toISOString()).toBe(before?.startsAt?.toISOString());
  });

  it("MUST NOT FIRE: the same move with force=1 succeeds and says it was FORCED", async () => {
    const response = await createOverlap();

    expect(response.status).toBe(302);
    const location = response.headers.get("location") ?? "";
    // One honest value: this placement is impossible, not merely untidy.
    expect(location).toContain("warn=forced");
    expect(location).not.toContain("warn=conflict");

    // The move was SAVED — forced, not refused.
    const row = await ctx.db.query.sessions.findFirst({
      where: eq(sessions.id, fixture.programSessionIds[1]),
    });
    expect(row?.roomId).toBe(fixture.roomIds[0]);
    expect(row?.startsAt?.toISOString()).toBe("2026-10-07T22:00:00.000Z");
    expect(await ctx.db.select().from(gateOverrides)).toMatchObject([
      {
        kind: "schedule_force",
        reason: "The room owner approved the overlap.",
        sessionId: fixture.programSessionIds[1],
        overriddenByName: expect.any(String),
      },
    ]);
  });

  it("MUST FIRE: a forced move without a reason is refused and writes nothing", async () => {
    const before = await ctx.db.query.sessions.findFirst({
      where: eq(sessions.id, fixture.programSessionIds[1]),
    });
    const result = (await post({
      intent: "schedule",
      sessionId: fixture.programSessionIds[1],
      roomId: fixture.roomIds[0],
      day: DAY_ONE,
      time: "15:00",
      durationMinutes: "30",
      view: "day",
      force: "1",
      reason: "   ",
    })) as { ok: false; error: string };

    expect(result).toMatchObject({ ok: false, error: expect.stringContaining("reason") });
    const after = await ctx.db.query.sessions.findFirst({
      where: eq(sessions.id, fixture.programSessionIds[1]),
    });
    expect(after?.roomId).toBe(before?.roomId);
    expect(after?.startsAt?.getTime()).toBe(before?.startsAt?.getTime());
    expect(await ctx.db.select().from(gateOverrides)).toEqual([]);
  });

  it("MUST NOT FIRE: an ADVISORY same-track clash applies with warn=conflict, never blocked", async () => {
    /*
     * The warn-never-block law of #13 survives #70 intact for advisory kinds.
     * Same TRACK as programme session 0, but a different room and a different
     * person — so nothing is physically double-booked and the move must land
     * with no force, carrying the ordinary conflict warning.
     */
    const target = await addUnscheduled("Parallel track talk");
    await ctx.db
      .update(sessions)
      .set({ trackId: fixture.trackIds[0] }) // same track as programme session 0
      .where(eq(sessions.id, target));

    const response = (await post({
      intent: "schedule",
      sessionId: target,
      roomId: fixture.roomIds[1], // a DIFFERENT room
      day: DAY_ONE,
      time: "15:00", // same time as session 0
      durationMinutes: "30",
      view: "day",
      returnDay: DAY_ONE,
    })) as Response;

    expect(response.status).toBe(302);
    const location = response.headers.get("location") ?? "";
    expect(location).toContain("warn=conflict");
    expect(location).not.toContain("warn=forced");

    // Applied, with no override of any kind.
    const row = await ctx.db.query.sessions.findFirst({ where: eq(sessions.id, target) });
    expect(row?.roomId).toBe(fixture.roomIds[1]);
    expect(row?.startsAt?.toISOString()).toBe("2026-10-07T22:00:00.000Z");
  });

  it("MUST NOT FIRE: a move into a FREE slot carries no warning", async () => {
    const response = (await post({
      intent: "schedule",
      sessionId: fixture.programSessionIds[1],
      roomId: fixture.roomIds[2],
      day: "2026-10-09",
      time: "10:00",
      durationMinutes: "30",
      view: "day",
    })) as Response;

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).not.toContain("warn=conflict");
  });

  it("surfaces the clash as a chip on both cards AND a row on the Conflicts screen", async () => {
    await createOverlap();
    const data = await load(`${BASE}?view=list`);

    expect(data.counts.conflicts).toBe(1);
    // chip data on BOTH sessions
    for (const id of fixture.programSessionIds) {
      const row = data.rows.find((r) => r.id === id);
      expect(row?.conflicts).toHaveLength(1);
      expect(row?.conflicts[0].label).toBe("Room double-booked · Main Stage");
    }

    // the chip renders in List view…
    const listHtml = renderToStaticMarkup(<AgendaScreen {...data} />);
    expect(listHtml).toContain(`data-conflict-chip="${fixture.programSessionIds[0]}"`);
    expect(listHtml).toContain(`data-conflict-chip="${fixture.programSessionIds[1]}"`);

    // …and as a row on the dedicated Conflicts screen, linking to both sessions.
    const conflictsData = await load(`${BASE}?view=conflicts`);
    const conflictsHtml = renderToStaticMarkup(<AgendaScreen {...conflictsData} />);
    expect(conflictsHtml).toContain(
      `data-conflict-row="${fixture.programSessionIds[0]}|${fixture.programSessionIds[1]}"`,
    );
    expect(conflictsHtml).toContain(`#session-${fixture.programSessionIds[0]}`);
    expect(conflictsHtml).toContain(`#session-${fixture.programSessionIds[1]}`);
    expect(conflictsHtml).toContain("Main Stage");
    expect(conflictsHtml).not.toContain("No conflicts.");
  });

  it("detects a SPEAKER double-booking across different rooms", async () => {
    // Put session 1's speaker on session 0 as well, then overlap them.
    const target = await addUnscheduled("Fireside with Sam");
    await ctx.db
      .update(sessions)
      .set({ trackId: fixture.trackIds[1] })
      .where(eq(sessions.id, target));
    await ctx.db.insert(
      (await import("~/db/schema")).sessionParticipants,
    ).values({
      sessionId: target,
      personId: fixture.speakerIds[0], // Sam Speaker — already on programme session 0
      role: "speaker",
      isPrimary: true,
      order: 0,
    });

    const response = (await post({
      intent: "schedule",
      sessionId: target,
      roomId: fixture.roomIds[1], // a DIFFERENT room
      day: DAY_ONE,
      time: "15:00", // same time as session 0
      durationMinutes: "30",
      view: "conflicts",
      force: "1", // a speaker double-booking is blocking, so it needs forcing
      reason: "Both speakers approved the overlap.",
    })) as Response;
    expect(response.headers.get("location")).toContain("warn=forced");

    const data = await load(`${BASE}?view=conflicts`);
    expect(data.conflictRows).toHaveLength(1);
    expect(data.conflictRows[0].kind).toBe("speaker");
    expect(data.conflictRows[0].label).toBe("Speaker double-booked · Sam Speaker");
    expect(data.conflictRows[0].overlapMinutes).toBe(30);
  });
});

describe("action: unschedule", () => {
  it("clears the times AND drops the session off the public schedule", async () => {
    const target = fixture.programSessionIds[0];
    expect(
      (await ctx.db.query.sessions.findFirst({ where: eq(sessions.id, target) }))?.isPublic,
    ).toBe(true);

    const response = (await post({
      intent: "unschedule",
      sessionId: target,
      view: "list",
    })) as Response;
    expect(response.status).toBe(302);

    const row = await ctx.db.query.sessions.findFirst({ where: eq(sessions.id, target) });
    expect(row?.startsAt).toBeNull();
    expect(row?.endsAt).toBeNull();
    // A session with no time must never remain on the public schedule.
    expect(row?.isPublic).toBe(false);
    expect(row?.publishedAt).toBeNull();
  });

  it("MUST NOT FIRE on an abstract", async () => {
    const result = await post({ intent: "unschedule", sessionId: fixture.abstractIds[0] });
    expect(result).toMatchObject({ ok: false });
  });
});

describe("action: publish", () => {
  it("MUST FIRE: toggles a scheduled session on and off", async () => {
    const target = fixture.programSessionIds[0];

    await post({ intent: "set-published", sessionId: target, published: "0", view: "list" });
    let row = await ctx.db.query.sessions.findFirst({ where: eq(sessions.id, target) });
    expect(row?.isPublic).toBe(false);
    expect(row?.publishedAt).toBeNull();

    await post({ intent: "set-published", sessionId: target, published: "1", view: "list" });
    row = await ctx.db.query.sessions.findFirst({ where: eq(sessions.id, target) });
    expect(row?.isPublic).toBe(true);
    expect(row?.publishedAt).toBeInstanceOf(Date);
  });

  it("MUST NOT FIRE: an UNSCHEDULED session cannot be published", async () => {
    const target = await addUnscheduled();
    const result = await post({
      intent: "set-published",
      sessionId: target,
      published: "1",
      view: "list",
    });

    expect(result).toMatchObject({ ok: false });
    const row = await ctx.db.query.sessions.findFirst({ where: eq(sessions.id, target) });
    expect(row?.isPublic).toBe(false);
  });

  it("publish-all publishes every scheduled session and skips the unscheduled ones", async () => {
    const unscheduled = await addUnscheduled();
    // Start from an all-draft programme.
    for (const id of fixture.programSessionIds) {
      await post({ intent: "set-published", sessionId: id, published: "0", view: "list" });
    }
    expect((await load()).counts.published).toBe(0);

    const response = (await post({ intent: "publish-all", view: "list" })) as Response;
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toContain("published=2");

    const data = await load();
    expect(data.counts.published).toBe(2);
    const row = await ctx.db.query.sessions.findFirst({ where: eq(sessions.id, unscheduled) });
    expect(row?.isPublic).toBe(false);
  });

  it("publish-all reports zero when there is nothing left to publish", async () => {
    const response = (await post({ intent: "publish-all", view: "list" })) as Response;
    expect(response.headers.get("location")).toContain("published=0");
  });
});

/**
 * Publish-all is the moment a double-booked room reaches the public schedule
 * and the ICS invites, so it carries the same `warn=conflict` the move path
 * already carries. A WARNING, not a gate: everything still publishes.
 */
describe("action: publish-all conflict warning", () => {
  /** Both programme sessions into ONE room at ONE time, and back to draft. */
  async function draftRoomOverlap(): Promise<void> {
    for (const id of fixture.programSessionIds) {
      await ctx.db
        .update(sessions)
        .set({
          roomId: fixture.roomIds[0],
          startsAt: new Date("2026-10-08T17:00:00.000Z"),
          endsAt: new Date("2026-10-08T18:00:00.000Z"),
          isPublic: false,
          publishedAt: null,
        })
        .where(eq(sessions.id, id));
    }
  }

  /** Seeded rooms and times, untouched and conflict-free — just unpublished. */
  async function draftConflictFree(): Promise<void> {
    for (const id of fixture.programSessionIds) {
      await ctx.db
        .update(sessions)
        .set({ isPublic: false, publishedAt: null })
        .where(eq(sessions.id, id));
    }
  }

  /** Same track, DIFFERENT rooms, overlapping times: advisory, never blocking. */
  async function draftTrackOverlap(): Promise<void> {
    for (const [index, id] of fixture.programSessionIds.entries()) {
      await ctx.db
        .update(sessions)
        .set({
          roomId: fixture.roomIds[index], // different rooms — no room double-booking
          trackId: fixture.trackIds[0], // the SAME track
          startsAt: new Date("2026-10-08T17:00:00.000Z"),
          endsAt: new Date("2026-10-08T18:00:00.000Z"),
          isPublic: false,
          publishedAt: null,
        })
        .where(eq(sessions.id, id));
    }
  }

  it("MUST FIRE: a room double-booking HOLDS both sessions instead of publishing them", async () => {
    /*
     * This replaces the pre-#70 law, which published a double-booked room and
     * merely warned. Publishing is the moment a conflict reaches the public
     * schedule and the ICS invites, and a room cannot host two sessions at once,
     * so the release gate refuses rather than warns.
     */
    await draftRoomOverlap();
    expect((await load()).counts.conflicts).toBe(1);

    const response = (await post({ intent: "publish-all", view: "list" })) as Response;
    const location = String(response.headers.get("location"));

    expect(response.status).toBe(302);
    expect(location).toContain("published=0");
    expect(location).toContain("blocked=2");

    // A gate, not a warning — neither conflicting session went public.
    for (const id of fixture.programSessionIds) {
      const row = await ctx.db.query.sessions.findFirst({ where: eq(sessions.id, id) });
      expect(row?.isPublic).toBe(false);
      expect(row?.publishedAt).toBeNull();
    }

    // And the operator can see WHICH session is held and WHY.
    const landing = new URL(location, BASE).toString();
    const data = await load(landing);
    const holds = data.publishHolds.map((hold) => hold.reasons.join(" "));
    expect(holds.length).toBe(2);
    expect(holds.every((reason) => reason.includes("Room double-booked · Main Stage"))).toBe(
      true,
    );
  });

  it("MUST NOT FIRE: force=1 publishes the double-booked pair anyway", async () => {
    await draftRoomOverlap();

    const response = (await post({
      intent: "publish-all",
      view: "list",
      force: "1",
    })) as Response;
    expect(String(response.headers.get("location"))).toContain("published=2");

    for (const id of fixture.programSessionIds) {
      const row = await ctx.db.query.sessions.findFirst({ where: eq(sessions.id, id) });
      expect(row?.isPublic).toBe(true);
    }
  });

  it("MUST NOT FIRE: an ADVISORY track overlap still publishes, and still warns", async () => {
    /*
     * The must-still-fire twin of the gate above. If the release gate ever
     * widened to every conflict kind, this case would go red — which is the
     * point: `warn=conflict` on publish must survive #70 for advisory kinds.
     */
    await draftTrackOverlap();
    expect((await load()).counts.conflicts).toBe(1);

    const response = (await post({ intent: "publish-all", view: "list" })) as Response;
    const location = String(response.headers.get("location"));

    expect(location).toContain("published=2");
    expect(location).toContain("blocked=0");
    expect(location).toContain("warn=conflict");

    // Advisory never gates: both went public.
    for (const id of fixture.programSessionIds) {
      const row = await ctx.db.query.sessions.findFirst({ where: eq(sessions.id, id) });
      expect(row?.isPublic).toBe(true);
    }

    // The param the redirect carries is the one the built banner reads.
    const landing = new URL(location, BASE).toString();
    expect((await load(landing)).warning).toBe("conflict");
    expect(await html(landing)).toContain('data-conflict-warning="1"');
  });

  it("MUST NOT FIRE: a conflict-free publish-all carries published=N and no warning", async () => {
    await draftConflictFree();
    expect((await load()).counts.conflicts).toBe(0);

    const response = (await post({ intent: "publish-all", view: "list" })) as Response;
    const location = String(response.headers.get("location"));

    expect(location).toContain("published=2");
    expect(location).not.toContain("warn");

    const landing = new URL(location, BASE).toString();
    expect((await load(landing)).warning).toBeNull();
    expect(await html(landing)).not.toContain('data-conflict-warning="1"');
  });

  it("MUST NOT FIRE: a standing conflict nobody just published raises no warning", async () => {
    // The overlap is already public, so publish-all writes nothing — and a
    // warning here would be about an agenda this action did not change.
    await draftRoomOverlap();
    await post({ intent: "publish-all", view: "list" });
    expect((await load()).counts.conflicts).toBe(1);

    const response = (await post({ intent: "publish-all", view: "list" })) as Response;
    const location = String(response.headers.get("location"));

    expect(location).toContain("published=0");
    expect(location).not.toContain("warn");
  });
});

/* ------------------------------------------------------------- render */

async function html(url: string): Promise<string> {
  return renderToStaticMarkup(<AgendaScreen {...(await load(url))} />);
}

describe("render: all six views against seed data", () => {
  it("List view leads with the unscheduled bucket", async () => {
    await addUnscheduled();
    const markup = await html(`${BASE}?view=list`);

    expect(markup).toContain("Unscheduled");
    expect(markup).toContain("Sponsor keynote: Vectorly");
    expect(markup).toContain("Shipping agents that survive contact with users");
    // the JS-off scheduling control is present on a card
    expect(markup).toContain('name="intent" value="schedule"');
    expect(markup).toContain('name="durationMinutes"');
    expect(markup).toContain("Wed, Oct 7, 2026");
  });

  it("Day view renders the room-column board and the drop form", async () => {
    const markup = await html(`${BASE}?view=day&day=${DAY_ONE}`);

    for (const room of ["Main Stage", "Workshop Room 1", "Workshop Room 2"]) {
      expect(markup).toContain(room);
    }
    // the grid rows
    expect(markup).toContain(">08:00<");
    expect(markup).toContain(">15:00<");
    // a card sitting in its slot
    expect(markup).toContain(`data-session-card="${fixture.programSessionIds[0]}"`);
    // the hidden form that BOTH drag and the card form post to
    expect(markup).toContain('id="agenda-drop-form"');
  });

  it("the Day tray is EXACTLY the unscheduled bucket, not 'anything unplaced'", async () => {
    await addUnscheduled(); // no time at all → tray
    // A session with a time but NO room is scheduled: it belongs to its day, and
    // must show in the off-grid note rather than inflating the tray count.
    await post({
      intent: "schedule",
      sessionId: fixture.programSessionIds[1],
      roomId: "",
      day: DAY_ONE,
      time: "16:00",
      durationMinutes: "30",
      view: "day",
    });

    const data = await load(`${BASE}?view=day&day=${DAY_ONE}`);
    expect(data.counts.unscheduled).toBe(1);

    const markup = renderToStaticMarkup(<AgendaScreen {...data} />);
    // tray heading count matches the stat tile
    expect(markup).toContain("Unscheduled");
    expect(markup).toContain('data-off-grid="1"');
    expect(markup).toContain("no room, or a start outside 08:00–20:00");
  });

  it("Week view groups the days of the conference", async () => {
    const markup = await html(`${BASE}?view=week`);
    expect(markup).toContain("Week 2026-W41");
    expect(markup).toContain("Wed, Oct 7, 2026");
    expect(markup).toContain("Fri, Oct 9, 2026");
    expect(markup).toContain(`data-week-item="${fixture.programSessionIds[0]}"`);
  });

  it("Track view lanes by track and keeps a No track bucket", async () => {
    const markup = await html(`${BASE}?view=track`);
    for (const track of ["Agents", "Evals &amp; Reliability", "Infrastructure"]) {
      expect(markup).toContain(track);
    }
    expect(markup).toContain("No track");
  });

  it("Room view lanes by room and keeps a No room bucket", async () => {
    const markup = await html(`${BASE}?view=room`);
    expect(markup).toContain("Main Stage");
    expect(markup).toContain("No room");
  });

  it("Conflicts view shows the clean state for a conflict-free programme", async () => {
    const markup = await html(`${BASE}?view=conflicts`);
    expect(markup).toContain("No conflicts.");
    expect(markup).not.toContain("data-conflict-row");
  });

  it("every view tab is reachable from every view", async () => {
    for (const view of ["list", "day", "week", "track", "room", "conflicts"]) {
      const markup = await html(`${BASE}?view=${view}`);
      for (const tab of ["list", "day", "week", "track", "room", "conflicts"]) {
        expect(markup, `${view} -> ${tab}`).toContain(`data-view-tab="${tab}"`);
      }
    }
  });
});

describe("render: zero states", () => {
  it("an event with NO programme sessions shows the empty state in every view", async () => {
    await ctx.db.delete(sessions).where(eq(sessions.isAbstract, false));

    const list = await html(`${BASE}?view=list`);
    expect(list).toContain("Nothing here yet");
    expect(list).toContain("Sessions will appear here in list view");

    const day = await html(`${BASE}?view=day`);
    expect(day).toContain("Main Stage"); // rooms still render as empty columns
    expect(day).toContain("Everything is on the agenda.");

    const conflicts = await html(`${BASE}?view=conflicts`);
    expect(conflicts).toContain("No conflicts.");

    const room = await html(`${BASE}?view=room`);
    expect(room).toContain("No sessions here yet.");
  });

  it("no event at all renders the seed prompt, not a crash", () => {
    const markup = renderToStaticMarkup(
      <AgendaScreen
        event={null}
        view="list"
        day={null}
        days={[]}
        rooms={[]}
        tracks={[]}
        rows={[]}
        conflictRows={[]}
        slots={[]}
        counts={{ total: 0, scheduled: 0, unscheduled: 0, published: 0, conflicts: 0 }}
        notice={null}
        warning={null}
        heldForUninformed={[]}
        publishHolds={[]}
      />,
    );
    // Product copy, not a developer instruction (the de-scaffolding gate in
    // app/lib/ui-copy-scan.test.ts bans the latter from any rendered screen).
    expect(markup).toContain("No event yet");
    expect(markup).toContain("come together");
    expect(markup).not.toContain("npm run seed");
  });

  it("the Day view explains itself when the event has no dates", async () => {
    const markup = renderToStaticMarkup(
      <AgendaScreen
        event={{ id: "e", name: "E", slug: "e", timezone: "UTC" }}
        view="day"
        day={null}
        days={[]}
        rooms={[]}
        tracks={[]}
        rows={[]}
        conflictRows={[]}
        slots={[]}
        counts={{ total: 0, scheduled: 0, unscheduled: 0, published: 0, conflicts: 0 }}
        notice={null}
        warning={null}
        heldForUninformed={[]}
        publishHolds={[]}
      />,
    );
    expect(markup).toContain("This event has no dates yet");
  });
});

describe("render: the default export", () => {
  it("surfaces an action error above the screen", async () => {
    const data = await load();
    const props = {
      loaderData: data,
      actionData: { ok: false, error: "Duration must be between 5 and 720 minutes." },
    } as unknown as Parameters<typeof AdminAgenda>[0];

    const markup = renderToStaticMarkup(<AdminAgenda {...props} />);
    expect(markup).toContain("Duration must be between 5 and 720 minutes.");
    expect(markup).toContain("Agenda");
  });

  it("renders the conflict warning banner after a warned move", async () => {
    const data = await load(`${BASE}?view=list&warn=conflict`);
    expect(data.warning).toBe("conflict");
    const markup = renderToStaticMarkup(<AgendaScreen {...data} />);
    expect(markup).toContain('data-conflict-warning="1"');
    expect(markup).toContain("It was saved anyway");
  });
});
