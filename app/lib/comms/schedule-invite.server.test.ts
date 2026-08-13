/**
 * The ICS lifecycle end to end against a real database — PLAN.md §7's binding
 * WS5 addendum: "stable UID, SEQUENCE bump on update, METHOD:CANCEL on
 * unschedule".
 *
 * `ics.test.ts` proves the builder emits a rising SEQUENCE when handed one.
 * THIS file proves the number actually rises in the running product, where it
 * is derived from the comm_log rows previous sends wrote — the half that a pure
 * test cannot see.
 */
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { events, sessionParticipants, sessions } from "~/db/schema";
import type { Event as EventRow } from "~/db/schema";
import { MemoryMailer } from "~/lib/mail/mailer";
import { installTestDb, type TestDbContext } from "~/test/db";
import { seedDemoFixture, type DemoFixture } from "~/test/fixtures";

import { listComms } from "./comm-log.server";
import { icsUid, icsValue, parseIcs } from "./ics";
import { notifyScheduleChange, priorSequences } from "./schedule-invite.server";

let ctx: TestDbContext;
let fixture: DemoFixture;
let event: EventRow;

const ORIGIN = "https://callboard.test";
const request = () => new Request(`${ORIGIN}/admin/agenda`);

beforeEach(async () => {
  ctx = installTestDb();
  fixture = await seedDemoFixture(ctx.db);
  [event] = await ctx.db.select().from(events).where(eq(events.id, fixture.eventId));
  mailer = new MemoryMailer();
});
afterEach(() => ctx.close());

/** Program session 0 is published, timed, and has one speaker in the fixture. */
const SESSION = () => fixture.programSessionIds[0];

async function snapshot(sessionId: string) {
  const row = await ctx.db.query.sessions.findFirst({ where: eq(sessions.id, sessionId) });
  return {
    startsAt: row?.startsAt ?? null,
    endsAt: row?.endsAt ?? null,
    isPublic: row?.isPublic ?? false,
  };
}

/** Collects the sent messages so the ICS BYTES can be asserted, not just counts. */
let mailer: MemoryMailer;

async function notify(
  change: Parameters<typeof notifyScheduleChange>[0]["change"],
  over: { sessionId?: string; before?: Awaited<ReturnType<typeof snapshot>> } = {},
) {
  const sessionId = over.sessionId ?? SESSION();
  const before = over.before ?? (await snapshot(sessionId));
  return notifyScheduleChange({
    request: request(),
    event,
    sessionId,
    change,
    before,
    db: ctx.db,
    mailer,
  });
}

/** Parsed ICS of the Nth message the seam handed the mailer. */
function icsOf(index: number) {
  return parseIcs(mailer.sent[index].attachments![0].content);
}

describe("the invite -> update -> cancel lifecycle", () => {
  it("MUST-FIRE: schedule -> invite, reschedule -> update, unschedule -> cancel", async () => {
    const first = await notify("scheduled");
    expect(first.action).toBe("invite");
    expect(first.sent).toBe(1);
    expect(first.sequence).toBe(0);

    // Move it. Same session, so the same UID, one higher SEQUENCE.
    await ctx.db
      .update(sessions)
      .set({
        startsAt: new Date("2026-10-08T21:00:00Z"),
        endsAt: new Date("2026-10-08T22:00:00Z"),
      })
      .where(eq(sessions.id, SESSION()));
    const second = await notify("scheduled");
    expect(second.action).toBe("update");
    expect(second.sequence).toBe(1);
    expect(second.uid).toBe(first.uid);

    // Unschedule: capture the times FIRST, the way the agenda action does.
    const before = await snapshot(SESSION());
    await ctx.db
      .update(sessions)
      .set({ startsAt: null, endsAt: null, isPublic: false, publishedAt: null })
      .where(eq(sessions.id, SESSION()));
    const third = await notify("unscheduled", { before });
    expect(third.action).toBe("cancel");
    expect(third.sequence).toBe(2);
    expect(third.uid).toBe(first.uid);

    const rows = await listComms({ eventId: fixture.eventId, db: ctx.db });
    expect(rows).toHaveLength(3);
    expect(rows.map((row) => row.templateKey)).toEqual([
      "schedule_cancel",
      "schedule_update",
      "schedule_invite",
    ]);
    // Newest first, so the sequences count DOWN through the log.
    expect(rows.map((row) => row.meta?.icsSequence)).toEqual([2, 1, 0]);
    expect(rows.map((row) => row.meta?.icsMethod)).toEqual(["CANCEL", "REQUEST", "REQUEST"]);
    expect(new Set(rows.map((row) => row.meta?.icsUid)).size).toBe(1);
    expect(rows.every((row) => row.status === "sent")).toBe(true);
  });

  it("MUST-FIRE: the UID is the session's, stable and derived from the origin", async () => {
    const result = await notify("scheduled");
    expect(result.uid).toBe(icsUid(SESSION(), "callboard.test"));
  });

  it("MUST-FIRE: priorSequences reads back exactly what was written", async () => {
    await notify("scheduled");
    await notify("scheduled");
    const uid = icsUid(SESSION(), "callboard.test");
    expect(await priorSequences(ctx.db, fixture.eventId, uid)).toEqual([0, 1]);
  });

  it("MUST-NOT-FIRE: another session's log does not raise this one's SEQUENCE", async () => {
    await notify("scheduled");
    await notify("scheduled");
    // A different session starts at 0 regardless of how much has been sent.
    await ctx.db
      .update(sessions)
      .set({ isPublic: true, publishedAt: new Date() })
      .where(eq(sessions.id, fixture.programSessionIds[1]));
    const other = await notify("scheduled", { sessionId: fixture.programSessionIds[1] });
    expect(other.action).toBe("invite");
    expect(other.sequence).toBe(0);
  });
});

describe("guards", () => {
  it("MUST-NOT-FIRE: an UNPUBLISHED session sends nothing when scheduled", async () => {
    await ctx.db
      .update(sessions)
      .set({ isPublic: false, publishedAt: null })
      .where(eq(sessions.id, SESSION()));

    const result = await notify("scheduled");
    expect(result.action).toBeNull();
    expect(result.sent).toBe(0);
    expect(result.skipped).toBe("session is not published");
    expect(await listComms({ eventId: fixture.eventId, db: ctx.db })).toEqual([]);
  });

  it("MUST-NOT-FIRE: unscheduling a session nobody was invited to sends nothing", async () => {
    const before = await snapshot(SESSION());
    const result = await notify("unscheduled", { before });
    expect(result.action).toBeNull();
    expect(result.skipped).toBe("no invite was ever sent");
  });

  it("MUST-NOT-FIRE: a session with no participants sends nothing", async () => {
    await ctx.db
      .delete(sessionParticipants)
      .where(eq(sessionParticipants.sessionId, SESSION()));

    const result = await notify("scheduled");
    expect(result.action).toBeNull();
    expect(result.skipped).toBe("session has no participants");
  });

  it("MUST-NOT-FIRE: a published session with no times sends nothing", async () => {
    await ctx.db
      .update(sessions)
      .set({ startsAt: null, endsAt: null })
      .where(eq(sessions.id, SESSION()));

    const result = await notify("scheduled");
    expect(result.action).toBeNull();
    expect(result.skipped).toBe("session has no times");
  });

  it("MUST-NOT-FIRE: a session id from another event is refused", async () => {
    const result = await notify("scheduled", {
      sessionId: "ffffffff-0000-4000-8000-000000000000",
    });
    expect(result.skipped).toBe("session not found");
  });

  it("MUST-FIRE: unpublishing an invited session cancels it", async () => {
    await notify("scheduled");
    const before = await snapshot(SESSION());
    await ctx.db
      .update(sessions)
      .set({ isPublic: false, publishedAt: null })
      .where(eq(sessions.id, SESSION()));

    const result = await notify("unpublished", { before });
    expect(result.action).toBe("cancel");
    expect(result.sent).toBe(1);
  });

  it("MUST-NOT-FIRE: unpublishing a session that was never public sends nothing", async () => {
    await notify("scheduled");
    const result = await notify("unpublished", {
      before: { startsAt: new Date(), endsAt: new Date(), isPublic: false },
    });
    expect(result.action).toBeNull();
    expect(result.skipped).toBe("session was not published");
  });
});

describe("the message itself", () => {
  it("goes to the session's speaker with an invite.ics attachment", async () => {
    await notify("scheduled");
    const rows = await listComms({ eventId: fixture.eventId, db: ctx.db });

    expect(rows[0].toEmail).toBe("speaker@callboard.dev");
    expect(rows[0].subject).toContain("Your slot at Frontier AI Summit 2026");
    expect(rows[0].meta?.hasIcs).toBe(true);
    expect(rows[0].meta?.sessionId).toBe(SESSION());

    expect(mailer.sent[0].attachments![0].filename).toBe("invite.ics");
    expect(mailer.sent[0].attachments![0].contentType).toBe(
      'text/calendar; charset="utf-8"; method=REQUEST',
    );
  });

  it("MUST-FIRE: the ICS bytes carry the real room, times and organizer", async () => {
    await notify("scheduled");
    const ics = icsOf(0);

    expect(icsValue(ics, "UID")).toBe(icsUid(SESSION(), "callboard.test"));
    expect(icsValue(ics, "METHOD")).toBe("REQUEST");
    expect(icsValue(ics, "SEQUENCE")).toBe("0");
    expect(icsValue(ics, "SUMMARY")).toBe(
      "Shipping agents that survive contact with users",
    );
    expect(icsValue(ics, "LOCATION")).toBe("Main Stage\\, San Francisco\\, CA");
    expect(icsValue(ics, "ATTENDEE")).toBe("mailto:speaker@callboard.dev");
    // No RESEND_FROM in the test env, so the sandbox sender is in force — and
    // the ORGANIZER must match whatever it is.
    expect(icsValue(ics, "ORGANIZER")).toBe("mailto:onboarding@resend.dev");
    expect(mailer.sent[0].from).toBe("Callboard <onboarding@resend.dev>");
    expect(icsValue(ics, "URL")).toBe(
      "https://callboard.test/e/frontier-ai-summit-2026/schedule",
    );
  });

  it("updates a later room assignment and never leaks a private video pitch", async () => {
    await ctx.db
      .update(sessions)
      .set({ roomId: null, videoUrl: "https://video.example/private-pitch" })
      .where(eq(sessions.id, SESSION()));
    const first = await notify("scheduled");
    expect(first.sequence).toBe(0);

    await ctx.db
      .update(sessions)
      .set({ roomId: fixture.roomIds[1] })
      .where(eq(sessions.id, SESSION()));
    const update = await notify("scheduled");
    const updatedIcs = icsOf(1);
    const raw = mailer.sent[1].attachments![0].content;

    expect(update.action).toBe("update");
    expect(update.uid).toBe(first.uid);
    expect(update.sequence).toBe(1);
    expect(icsValue(updatedIcs, "LOCATION")).toBe("Workshop Room 1\\, San Francisco\\, CA");
    expect(icsValue(updatedIcs, "URL")).toBe(
      "https://callboard.test/e/frontier-ai-summit-2026/schedule",
    );
    expect(raw).not.toContain("video.example/private-pitch");
  });

  it("MUST-FIRE: the cancel ICS keeps the times the slot HELD, not nulls", async () => {
    await notify("scheduled");
    const before = await snapshot(SESSION());
    await ctx.db
      .update(sessions)
      .set({ startsAt: null, endsAt: null, isPublic: false, publishedAt: null })
      .where(eq(sessions.id, SESSION()));
    await notify("unscheduled", { before });

    const cancel = icsOf(1);
    expect(icsValue(cancel, "METHOD")).toBe("CANCEL");
    expect(icsValue(cancel, "STATUS")).toBe("CANCELLED");
    expect(icsValue(cancel, "DTSTART")).toBe(icsValue(icsOf(0), "DTSTART"));
    expect(icsValue(cancel, "DTSTART")).toMatch(/^\d{8}T\d{6}Z$/);
  });

  it("one message per participant, and each is logged against that person", async () => {
    await ctx.db.insert(sessionParticipants).values({
      sessionId: SESSION(),
      personId: fixture.speakerIds[3],
      role: "co_speaker",
      isPrimary: false,
      order: 1,
    });

    const result = await notify("scheduled");
    expect(result.sent).toBe(2);

    const rows = await listComms({ eventId: fixture.eventId, db: ctx.db });
    expect(rows.map((row) => row.toEmail).sort()).toEqual([
      "mira@example.com",
      "speaker@callboard.dev",
    ]);
    expect(new Set(rows.map((row) => row.meta?.icsSequence))).toEqual(new Set([0]));
  });
});
