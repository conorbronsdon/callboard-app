/**
 * The release gate on BLOCKING conflicts, and how it composes with the informed
 * gate (DECISIONS.md #70, refining #13).
 *
 * Two independent holds now sit in front of the public schedule:
 *   - the speaker has not been told  -> cleared by `override=1`
 *   - a room or person is double-booked -> cleared by `force=1`
 * They are deliberately separate parameters. One shared override would let an
 * organizer clearing a "we already emailed them" hold silently also publish a
 * physically impossible schedule, which is the failure this file pins.
 *
 * Every carve-out gets its must-not-fire twin, because a gate that holds
 * everything and a gate that holds nothing both pass a test that only checks
 * "publish-all returned a redirect".
 */
import { renderToStaticMarkup } from "react-dom/server";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { gateOverrides, sessionParticipants, sessions } from "~/db/schema";
import { signedInGet, signedInPost } from "~/test/auth";
import { installTestDb, type TestDbContext } from "~/test/db";
import { seedDemoFixture, type DemoFixture } from "~/test/fixtures";

import { AgendaScreen, action, loader } from "./admin.agenda";
import type { AgendaData } from "./admin.agenda";

type LoaderArgs = Parameters<typeof loader>[0];
type ActionArgs = Parameters<typeof action>[0];

const asLoaderArgs = (request: Request) =>
  ({ request, params: {}, context: {} }) as unknown as LoaderArgs;
const asActionArgs = (request: Request) =>
  ({ request, params: {}, context: {} }) as unknown as ActionArgs;

const BASE = "https://x.test/admin/agenda";
const DAY_ONE = "2026-10-07";
/** 15:00 America/Los_Angeles on DAY_ONE — where seeded session 0 already sits. */
const SLOT_UTC = "2026-10-07T22:00:00.000Z";

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

const rowFor = async (id: string) =>
  ctx.db.query.sessions.findFirst({ where: eq(sessions.id, id) });

/** Put both seeded programme sessions in one room at one time: a hard clash. */
async function makeRoomClash(): Promise<void> {
  for (const id of fixture.programSessionIds) {
    await ctx.db
      .update(sessions)
      .set({
        roomId: fixture.roomIds[0],
        startsAt: new Date(SLOT_UTC),
        endsAt: new Date("2026-10-07T22:30:00.000Z"),
        isPublic: false,
        publishedAt: null,
      })
      .where(eq(sessions.id, id));
  }
}

/* ------------------------------------------------- feature 1: prediction */

describe("the move action predicts BEFORE it writes", () => {
  it("MUST FIRE: dryRun returns the conflicts the move would create", async () => {
    const result = (await post({
      intent: "schedule",
      sessionId: fixture.programSessionIds[1],
      roomId: fixture.roomIds[0], // onto session 0
      day: DAY_ONE,
      time: "15:00",
      durationMinutes: "30",
      view: "day",
      dryRun: "1",
    })) as { ok: true; prediction: { blocking: string[]; advisory: string[] } };

    expect(result.ok).toBe(true);
    expect(result.prediction.blocking.join(" ")).toContain("Room double-booked · Main Stage");
    expect(result.prediction.advisory).toEqual([]);
  });

  it("MUST NOT FIRE: a dry run writes NOTHING", async () => {
    const before = await rowFor(fixture.programSessionIds[1]);

    await post({
      intent: "schedule",
      sessionId: fixture.programSessionIds[1],
      roomId: fixture.roomIds[0],
      day: DAY_ONE,
      time: "15:00",
      durationMinutes: "30",
      view: "day",
      dryRun: "1",
    });

    const after = await rowFor(fixture.programSessionIds[1]);
    expect(after?.roomId).toBe(before?.roomId);
    expect(after?.startsAt?.toISOString()).toBe(before?.startsAt?.toISOString());
  });

  it("MUST NOT FIRE: predicting a CLEAN slot reports nothing at all", async () => {
    const result = (await post({
      intent: "schedule",
      sessionId: fixture.programSessionIds[1],
      roomId: fixture.roomIds[2],
      day: "2026-10-09",
      time: "10:00",
      durationMinutes: "30",
      view: "day",
      dryRun: "1",
    })) as { ok: true; prediction: { blocking: string[]; advisory: string[] } };

    expect(result.prediction.blocking).toEqual([]);
    expect(result.prediction.advisory).toEqual([]);
  });
});

/* --------------------------------------- feature 3: the release gate */

describe("set-published refuses a blocking-conflicted session unless forced", () => {
  it("MUST FIRE: publishing one half of a double-booked room is refused", async () => {
    await makeRoomClash();
    const target = fixture.programSessionIds[0];

    const result = (await post({
      intent: "set-published",
      sessionId: target,
      published: "1",
      view: "list",
    })) as { ok: false; error: string };

    expect(result.ok).toBe(false);
    expect(result.error).toContain("Room double-booked · Main Stage");

    const row = await rowFor(target);
    expect(row?.isPublic).toBe(false);
    expect(row?.publishedAt).toBeNull();
  });

  it("MUST NOT FIRE: force=1 publishes that same session", async () => {
    await makeRoomClash();
    const target = fixture.programSessionIds[0];

    const response = await post({
      intent: "set-published",
      sessionId: target,
      published: "1",
      force: "1",
      reason: "Venue approved the shared room.",
      view: "list",
    });
    expect(response).toBeInstanceOf(Response);

    const row = await rowFor(target);
    expect(row?.isPublic).toBe(true);
    expect(row?.publishedAt).toBeInstanceOf(Date);
    expect(await ctx.db.select().from(gateOverrides)).toMatchObject([
      {
        kind: "publish_force",
        reason: "Venue approved the shared room.",
        sessionId: target,
        overriddenByName: expect.any(String),
      },
    ]);
  });

  it("MUST FIRE: publish force without a reason is refused and writes nothing", async () => {
    await makeRoomClash();
    const target = fixture.programSessionIds[0];

    const result = (await post({
      intent: "set-published",
      sessionId: target,
      published: "1",
      force: "1",
      reason: " ",
      view: "list",
    })) as { ok: false; error: string };

    expect(result).toMatchObject({ ok: false, error: expect.stringContaining("reason") });
    expect((await rowFor(target))?.isPublic).toBe(false);
    expect(await ctx.db.select().from(gateOverrides)).toEqual([]);
  });

  it("MUST NOT FIRE: the conflict gate never blocks UNpublishing", async () => {
    await makeRoomClash();
    const target = fixture.programSessionIds[0];
    await ctx.db
      .update(sessions)
      .set({ isPublic: true, publishedAt: new Date() })
      .where(eq(sessions.id, target));

    await post({ intent: "set-published", sessionId: target, published: "0", view: "list" });
    expect((await rowFor(target))?.isPublic).toBe(false);
  });

  it("MUST NOT FIRE: an informed, conflict-free session still publishes with no override", async () => {
    const target = fixture.programSessionIds[0];
    await ctx.db
      .update(sessions)
      .set({ isPublic: false, publishedAt: null })
      .where(eq(sessions.id, target));

    await post({ intent: "set-published", sessionId: target, published: "1", view: "list" });
    expect((await rowFor(target))?.isPublic).toBe(true);
  });
});

/* ------------------------------- composition with the informed gate */

describe("a session held for BOTH reasons lists both, and needs both keys", () => {
  /**
   * `doubly` is uninformed AND double-booked against seeded session 0.
   * An abstract points at it, which is what makes the informed gate apply.
   */
  async function addDoublyHeld(): Promise<string> {
    const id = "both-held-1";
    await ctx.db.insert(sessions).values({
      id,
      eventId: fixture.eventId,
      friendlyId: "BOTH-1",
      title: "Doubly held: agent evals",
      status: "accepted",
      isAbstract: false,
      roomId: fixture.roomIds[0], // Main Stage, where seeded session 0 sits…
      trackId: fixture.trackIds[2],
      formatId: fixture.formatIds[0],
      startsAt: new Date(SLOT_UTC), // …at exactly its time
      endsAt: new Date("2026-10-07T22:30:00.000Z"),
      isPublic: false,
      speakerInformedAt: null, // and nobody has been told
    });
    await ctx.db.insert(sessionParticipants).values({
      sessionId: id,
      personId: fixture.speakerIds[2],
      role: "speaker",
      isPrimary: true,
      order: 0,
    });
    await ctx.db.insert(sessions).values({
      id: "both-held-abs",
      eventId: fixture.eventId,
      friendlyId: "BOTH-ABS",
      title: "Doubly held: agent evals",
      status: "accepted",
      isAbstract: true,
      composedIntoSessionId: id,
    });
    return id;
  }

  it("MUST FIRE: publishHolds names the session once with BOTH reasons, and renders them", async () => {
    const doubly = await addDoublyHeld();

    const data = await load(`${BASE}?view=list`);
    const hold = data.publishHolds.find((row) => row.id === doubly);

    expect(hold).toBeDefined();
    // Once, not twice — one row carrying two reasons.
    expect(data.publishHolds.filter((row) => row.id === doubly)).toHaveLength(1);
    expect(hold!.reasons).toContain("Speaker not yet informed");
    expect(hold!.reasons.join(" ")).toContain("Room double-booked · Main Stage");

    const markup = renderToStaticMarkup(<AgendaScreen {...data} />);
    expect(markup).toContain("Doubly held: agent evals");
    expect(markup).toContain("Speaker not yet informed");
    expect(markup).toContain("Room double-booked · Main Stage");
  });

  it("MUST FIRE: publish-all holds it, and counts it under BOTH held and blocked", async () => {
    const doubly = await addDoublyHeld();

    const response = (await post({ intent: "publish-all", view: "list" })) as Response;
    const location = response.headers.get("location") ?? "";

    expect((await rowFor(doubly))?.isPublic).toBe(false);
    expect(location).toContain("held=1");
    expect(location).toContain("blocked=1");
  });

  it("MUST FIRE: one override alone is not enough — each gate needs its own key", async () => {
    const doubly = await addDoublyHeld();

    // Informed-gate override only: the conflict hold must still refuse.
    const onlyOverride = (await post({
      intent: "set-published",
      sessionId: doubly,
      published: "1",
      override: "1",
      reason: "Speaker confirmed outside callboard.",
      view: "list",
    })) as { ok: false; error: string };
    expect(onlyOverride.ok).toBe(false);
    expect(onlyOverride.error).toContain("Room double-booked");
    expect((await rowFor(doubly))?.isPublic).toBe(false);

    // Conflict override only: the informed hold must still refuse.
    const onlyForce = (await post({
      intent: "set-published",
      sessionId: doubly,
      published: "1",
      force: "1",
      reason: "Venue approved the overlap.",
      view: "list",
    })) as { ok: false; error: string };
    expect(onlyForce.ok).toBe(false);
    expect(onlyForce.error).toContain("Speaker not yet informed");
    expect((await rowFor(doubly))?.isPublic).toBe(false);
  });

  it("MUST NOT FIRE: both keys together publish it", async () => {
    const doubly = await addDoublyHeld();

    const response = await post({
      intent: "set-published",
      sessionId: doubly,
      published: "1",
      override: "1",
      force: "1",
      reason: "Speaker and venue both confirmed.",
      view: "list",
    });
    expect(response).toBeInstanceOf(Response);
    expect((await rowFor(doubly))?.isPublic).toBe(true);
    expect(await ctx.db.select().from(gateOverrides)).toMatchObject([
      { kind: "publish_override", reason: "Speaker and venue both confirmed.", sessionId: doubly },
      { kind: "publish_force", reason: "Speaker and venue both confirmed.", sessionId: doubly },
    ]);
  });

  it("MUST FIRE: the banner's own button carries exactly the keys that session needs", async () => {
    /*
     * The rendered affordance must be sufficient. If the banner offered only
     * `override=1` for a doubly-held session, clicking it would bounce off the
     * conflict gate and look broken.
     */
    await addDoublyHeld();
    const markup = renderToStaticMarkup(<AgendaScreen {...(await load(`${BASE}?view=list`))} />);

    expect(markup).toContain('name="override" value="1"');
    expect(markup).toContain('name="force" value="1"');
  });
});

/* --------------------------------------------- the Conflicts view split */

describe("the Conflicts view separates the two classes", () => {
  it("MUST FIRE: a blocking clash renders under the blocking severity", async () => {
    await makeRoomClash();
    const data = await load(`${BASE}?view=conflicts`);

    expect(data.conflictRows).toHaveLength(1);
    expect(data.conflictRows[0].kind).toBe("room");
    expect(data.conflictRows[0].severity).toBe("blocking");

    const markup = renderToStaticMarkup(<AgendaScreen {...data} />);
    expect(markup).toContain('data-conflict-severity="blocking"');
    expect(markup).not.toContain('data-conflict-severity="advisory"');
  });

  it("MUST NOT FIRE: a same-track clash renders as advisory, not blocking", async () => {
    for (const [index, id] of fixture.programSessionIds.entries()) {
      await ctx.db
        .update(sessions)
        .set({
          roomId: fixture.roomIds[index], // different rooms
          trackId: fixture.trackIds[0], // same track
          startsAt: new Date(SLOT_UTC),
          endsAt: new Date("2026-10-07T22:30:00.000Z"),
        })
        .where(eq(sessions.id, id));
    }

    const data = await load(`${BASE}?view=conflicts`);
    expect(data.conflictRows).toHaveLength(1);
    expect(data.conflictRows[0].kind).toBe("track");
    expect(data.conflictRows[0].severity).toBe("advisory");
    expect(data.conflictRows[0].label).toContain("Track overlap");

    const markup = renderToStaticMarkup(<AgendaScreen {...data} />);
    expect(markup).toContain('data-conflict-severity="advisory"');
    expect(markup).not.toContain('data-conflict-severity="blocking"');
  });
});
