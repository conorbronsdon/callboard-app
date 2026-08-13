import { and, eq, isNull } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { commLog, sessionParticipants, sessions, tasks } from "~/db/schema";
import { templateKeyOf } from "~/lib/comms/comm-log.server";
import { MemoryMailer } from "~/lib/mail/mailer";
import { installTestDb, type TestDbContext } from "~/test/db";
import { seedDemoFixture, type DemoFixture } from "~/test/fixtures";

import { applyAbstractStatus, commitQueues } from "./commit.server";

const ORIGIN = "https://callboard.test";

/** Decision rows only — the log also carries confirmations and reminders. */
async function decisionRows() {
  const rows = await ctx.db.select().from(commLog);
  return rows.filter((row) =>
    ["decision_accept", "decision_decline"].includes(templateKeyOf(row.meta) ?? ""),
  );
}

let ctx: TestDbContext;
let fixture: DemoFixture;

beforeEach(async () => {
  ctx = installTestDb();
  fixture = await seedDemoFixture(ctx.db);
});
afterEach(() => ctx.close());

const EXPECTED_TASK_TITLES = [
  "Complete your bio",
  "Confirm your slot",
  "Submit your slides",
  "Upload a headshot",
];

async function composedProgramme(abstractId: string) {
  const abstract = await ctx.db.query.sessions.findFirst({
    where: eq(sessions.id, abstractId),
  });
  expect(abstract?.composedIntoSessionId).toBeTruthy();
  const programme = await ctx.db.query.sessions.findFirst({
    where: eq(sessions.id, abstract!.composedIntoSessionId!),
  });
  expect(programme).toBeDefined();
  return { abstract: abstract!, programme: programme! };
}

async function sideEffectShape(abstractId: string) {
  const { abstract, programme } = await composedProgramme(abstractId);
  const participants = await ctx.db
    .select()
    .from(sessionParticipants)
    .where(eq(sessionParticipants.sessionId, programme.id));
  const createdTasks = await ctx.db
    .select()
    .from(tasks)
    .where(eq(tasks.sessionId, programme.id));
  return {
    abstract,
    programme,
    participantCount: participants.length,
    taskCount: createdTasks.length,
    taskTitles: createdTasks.map((task) => task.title).sort(),
  };
}

describe("applyAbstractStatus", () => {
  it("must fire: accepting a pending abstract composes its programme, participants and template tasks", async () => {
    const abstractId = fixture.abstractIds[3];
    const source = await ctx.db.query.sessions.findFirst({
      where: eq(sessions.id, abstractId),
    });

    const result = await applyAbstractStatus({
      eventId: fixture.eventId,
      abstractId,
      db: ctx.db,
      notify: false,
      status: "accepted",
      now: new Date("2026-08-12T18:00:00.000Z"),
    });

    expect(result).toEqual({
      status: "accepted",
      sessionsComposed: 1,
      tasksCreated: 4,
      notified: 0,
      notifyFailed: 0,
    });
    const { abstract, programme } = await composedProgramme(abstractId);
    expect(abstract.status).toBe("accepted");
    expect(programme.id).toBe(abstract.composedIntoSessionId);
    expect(programme.id).not.toBe(abstract.id);
    expect(programme).toMatchObject({
      eventId: fixture.eventId,
      title: source!.title,
      description: source!.description,
      status: "accepted",
      isAbstract: false,
      trackId: source!.trackId,
      formatId: source!.formatId,
      levelId: source!.levelId,
      capacity: source!.capacity,
      roomId: null,
      startsAt: null,
      endsAt: null,
      isPublic: false,
    });

    const carried = await ctx.db
      .select()
      .from(sessionParticipants)
      .where(eq(sessionParticipants.sessionId, programme.id));
    expect(carried.map((row) => [row.personId, row.role, row.isPrimary, row.order])).toEqual([
      [fixture.speakerIds[3], "speaker", true, 0],
    ]);

    const created = await ctx.db
      .select()
      .from(tasks)
      .where(eq(tasks.sessionId, programme.id));
    expect(created).toHaveLength(4);
    expect(created.map((task) => task.id).every(Boolean)).toBe(true);
    expect(created.map((task) => task.personId)).toEqual([
      fixture.speakerIds[3],
      fixture.speakerIds[3],
      fixture.speakerIds[3],
      fixture.speakerIds[3],
    ]);
    expect(created.map((task) => task.templateId).sort()).toEqual(
      [...fixture.templateIds].sort(),
    );
    expect(created.map((task) => task.title).sort()).toEqual(EXPECTED_TASK_TITLES);
  });

  it("must fire: radio accept and queue commit keep the same composition shape", async () => {
    const radioId = fixture.abstractIds[3];
    const queuedId = fixture.abstractIds[2];

    const radioResult = await applyAbstractStatus({
      eventId: fixture.eventId,
      abstractId: radioId,
      db: ctx.db,
      notify: false,
      status: "accepted",
    });
    const queueResult = await commitQueues(fixture.eventId, { db: ctx.db, notify: false });
    const radio = await sideEffectShape(radioId);
    const queued = await sideEffectShape(queuedId);

    expect(radioResult.sessionsComposed).toBe(1);
    expect(queueResult.sessionsComposed).toBe(1);
    expect({
      participants: radio.participantCount,
      tasks: radio.taskCount,
      taskTitles: radio.taskTitles,
    }).toEqual({
      participants: queued.participantCount,
      tasks: queued.taskCount,
      taskTitles: queued.taskTitles,
    });
    expect(radio.participantCount).toBe(1);
    expect(radio.taskCount).toBe(4);
  });

  it("must fire: the composed row satisfies both the agenda and portal predicates", async () => {
    const abstractId = fixture.abstractIds[4];
    await applyAbstractStatus({
      eventId: fixture.eventId,
      abstractId,
      db: ctx.db,
      notify: false,
      status: "accepted",
    });
    const abstract = await ctx.db.query.sessions.findFirst({
      where: eq(sessions.id, abstractId),
    });

    const agendaRows = await ctx.db
      .select()
      .from(sessions)
      .where(
        and(
          eq(sessions.eventId, fixture.eventId),
          eq(sessions.isAbstract, false),
          isNull(sessions.deletedAt),
        ),
      );
    expect(agendaRows.map((row) => row.id)).toContain(abstract!.composedIntoSessionId);

    const portalProgramme = await ctx.db.query.sessions.findFirst({
      where: and(
        eq(sessions.id, abstract!.composedIntoSessionId!),
        eq(sessions.eventId, fixture.eventId),
        eq(sessions.isAbstract, false),
        isNull(sessions.deletedAt),
      ),
    });
    expect(portalProgramme?.id).toBe(abstract!.composedIntoSessionId);
    expect(abstract?.status).toBe("accepted");
  });

  it("must NOT fire: committed then radio-accepted, or radio-accepted twice, never duplicates side effects", async () => {
    const committedId = fixture.abstractIds[2];
    await commitQueues(fixture.eventId, { db: ctx.db, notify: false });
    const committedBefore = await sideEffectShape(committedId);
    const afterCommit = await applyAbstractStatus({
      eventId: fixture.eventId,
      abstractId: committedId,
      db: ctx.db,
      notify: false,
      status: "accepted",
    });
    const committedAfter = await sideEffectShape(committedId);

    expect(afterCommit).toEqual({
      status: "accepted",
      sessionsComposed: 0,
      tasksCreated: 0,
      notified: 0,
      notifyFailed: 0,
    });
    expect(committedAfter.programme.id).toBe(committedBefore.programme.id);
    expect(committedAfter.participantCount).toBe(1);
    expect(committedAfter.taskCount).toBe(4);

    const directId = fixture.abstractIds[3];
    const first = await applyAbstractStatus({
      eventId: fixture.eventId,
      abstractId: directId,
      db: ctx.db,
      notify: false,
      status: "accepted",
    });
    const directBefore = await sideEffectShape(directId);
    const second = await applyAbstractStatus({
      eventId: fixture.eventId,
      abstractId: directId,
      db: ctx.db,
      notify: false,
      status: "accepted",
    });
    const directAfter = await sideEffectShape(directId);

    expect(first).toEqual({
      status: "accepted",
      sessionsComposed: 1,
      tasksCreated: 4,
      notified: 0,
      notifyFailed: 0,
    });
    expect(second).toEqual({
      status: "accepted",
      sessionsComposed: 0,
      tasksCreated: 0,
      notified: 0,
      notifyFailed: 0,
    });
    expect(directAfter.programme.id).toBe(directBefore.programme.id);
    expect(directAfter.participantCount).toBe(1);
    expect(directAfter.taskCount).toBe(4);

    const liveProgrammesForBoth = await ctx.db
      .select()
      .from(sessions)
      .where(
        and(
          eq(sessions.eventId, fixture.eventId),
          eq(sessions.isAbstract, false),
          isNull(sessions.deletedAt),
        ),
      );
    expect(
      liveProgrammesForBoth.filter(
        (row) =>
          row.title === committedBefore.abstract.title || row.title === directBefore.abstract.title,
      ),
    ).toHaveLength(2);
  });

  /*
   * The complement of the ABS-32 skip. "Compose nothing" must not decay into
   * "do nothing": an abstract that already owns a live programme session and is
   * sitting back in Accept Queue has to come out of a radio accept ACCEPTED.
   * The skip path writes no composition statements at all, so the status flip
   * is the only thing keeping this row from being stranded mid-pipeline.
   */
  it("must fire: accepting an already-composed row still flips its status", async () => {
    const abstractId = fixture.abstractIds[0];
    const before = await ctx.db.query.sessions.findFirst({
      where: eq(sessions.id, abstractId),
    });
    expect(before?.composedIntoSessionId).toBeTruthy();

    await applyAbstractStatus({
      eventId: fixture.eventId,
      abstractId,
      db: ctx.db,
      notify: false,
      status: "accept_queue",
    });
    const programmesBefore = await ctx.db
      .select()
      .from(sessions)
      .where(and(eq(sessions.eventId, fixture.eventId), eq(sessions.isAbstract, false)));

    const result = await applyAbstractStatus({
      eventId: fixture.eventId,
      abstractId,
      db: ctx.db,
      notify: false,
      status: "accepted",
    });

    const after = await ctx.db.query.sessions.findFirst({
      where: eq(sessions.id, abstractId),
    });
    const programmesAfter = await ctx.db
      .select()
      .from(sessions)
      .where(and(eq(sessions.eventId, fixture.eventId), eq(sessions.isAbstract, false)));

    expect(result).toEqual({
      status: "accepted",
      sessionsComposed: 0,
      tasksCreated: 0,
      notified: 0,
      notifyFailed: 0,
    });
    expect(after?.status).toBe("accepted");
    // The original programme session is kept, not replaced by a fresh one.
    expect(after?.composedIntoSessionId).toBe(before?.composedIntoSessionId);
    expect(programmesAfter).toHaveLength(programmesBefore.length);
  });

  it("must NOT fire: pending and queue transitions only change status", async () => {
    const abstractId = fixture.abstractIds[3];
    const sessionsBefore = await ctx.db.select().from(sessions);
    const tasksBefore = await ctx.db.select().from(tasks);

    for (const status of ["pending", "accept_queue", "decline_queue"] as const) {
      const result = await applyAbstractStatus({
        eventId: fixture.eventId,
        abstractId,
        db: ctx.db,
        notify: false,
        status,
      });
      expect(result).toEqual({
        status,
        sessionsComposed: 0,
        tasksCreated: 0,
        notified: 0,
        notifyFailed: 0,
      });
      const row = await ctx.db.query.sessions.findFirst({
        where: eq(sessions.id, abstractId),
      });
      expect(row?.status).toBe(status);
      expect(row?.composedIntoSessionId).toBeNull();
    }

    expect(await ctx.db.select().from(sessions)).toHaveLength(sessionsBefore.length);
    expect(await ctx.db.select().from(tasks)).toHaveLength(tasksBefore.length);
  });

  it("must NOT fire: changing an unrelated abstract leaves withdrawn rows untouched", async () => {
    const withdrawnId = fixture.abstractIds[7];
    await applyAbstractStatus({
      eventId: fixture.eventId,
      abstractId: fixture.abstractIds[3],
      db: ctx.db,
      notify: false,
      status: "accept_queue",
    });

    const withdrawn = await ctx.db.query.sessions.findFirst({
      where: eq(sessions.id, withdrawnId),
    });
    const withdrawnTasks = await ctx.db
      .select()
      .from(tasks)
      .where(eq(tasks.personId, fixture.speakerIds[7]));
    expect(withdrawn?.status).toBe("withdrawn");
    expect(withdrawn?.composedIntoSessionId).toBeNull();
    expect(withdrawnTasks).toHaveLength(0);
  });

  it("must NOT fire: declining changes status without composing sessions or tasks", async () => {
    const abstractId = fixture.abstractIds[5];
    const sessionsBefore = await ctx.db.select().from(sessions);
    const tasksBefore = await ctx.db.select().from(tasks);

    const result = await applyAbstractStatus({
      eventId: fixture.eventId,
      abstractId,
      db: ctx.db,
      notify: false,
      status: "declined",
    });
    const declined = await ctx.db.query.sessions.findFirst({
      where: eq(sessions.id, abstractId),
    });

    expect(result).toEqual({
      status: "declined",
      sessionsComposed: 0,
      tasksCreated: 0,
      notified: 0,
      notifyFailed: 0,
    });
    expect(declined?.status).toBe("declined");
    expect(declined?.composedIntoSessionId).toBeNull();
    expect(await ctx.db.select().from(sessions)).toHaveLength(sessionsBefore.length);
    expect(await ctx.db.select().from(tasks)).toHaveLength(tasksBefore.length);
  });

  it("repairs missing and soft-deleted programme back-links instead of treating them as composed", async () => {
    const missingId = fixture.abstractIds[3];
    await ctx.db
      .update(sessions)
      .set({ composedIntoSessionId: "missing-programme" })
      .where(eq(sessions.id, missingId));
    const missingResult = await applyAbstractStatus({
      eventId: fixture.eventId,
      abstractId: missingId,
      db: ctx.db,
      notify: false,
      status: "accepted",
    });
    const repairedMissing = await composedProgramme(missingId);
    expect(missingResult.sessionsComposed).toBe(1);
    expect(repairedMissing.programme.id).not.toBe("missing-programme");

    const softDeletedId = "soft-deleted-programme";
    const softDeletedAbstractId = fixture.abstractIds[4];
    await ctx.db.insert(sessions).values({
      id: softDeletedId,
      eventId: fixture.eventId,
      title: "Old composed row",
      status: "accepted",
      isAbstract: false,
      deletedAt: new Date("2026-08-11T12:00:00.000Z"),
    });
    await ctx.db
      .update(sessions)
      .set({ composedIntoSessionId: softDeletedId })
      .where(eq(sessions.id, softDeletedAbstractId));
    const deletedResult = await applyAbstractStatus({
      eventId: fixture.eventId,
      abstractId: softDeletedAbstractId,
      db: ctx.db,
      notify: false,
      status: "accepted",
    });
    const repairedDeleted = await composedProgramme(softDeletedAbstractId);
    expect(deletedResult.sessionsComposed).toBe(1);
    expect(repairedDeleted.programme.id).not.toBe(softDeletedId);
    expect(repairedDeleted.programme.deletedAt).toBeNull();
  });
});

/**
 * One composer, one NOTIFIER, two callers.
 *
 * A speaker cannot tell which control an organizer used, so the radio has to
 * produce the same email a committed decision does — and exactly one of it.
 * These read the comm log as well as the mailer because the log is the audit
 * trail the admin comms screen renders; a send that never lands a row is
 * invisible to the organizer who has to answer "did we tell them?".
 */
describe("applyAbstractStatus decision notifications", () => {
  it("must fire: a radio accept mails the speaker and logs it, exactly like a commit", async () => {
    const abstractId = fixture.abstractIds[3];
    const mailer = new MemoryMailer();

    const result = await applyAbstractStatus({
      eventId: fixture.eventId,
      abstractId,
      status: "accepted",
      origin: ORIGIN,
      mailer,
      db: ctx.db,
    });

    expect(result).toMatchObject({ notified: 1, notifyFailed: 0 });
    expect(mailer.sent).toHaveLength(1);

    const rows = await decisionRows();
    expect(rows).toHaveLength(1);
    expect(templateKeyOf(rows[0].meta)).toBe("decision_accept");
    expect(rows[0].meta).toMatchObject({ decision: "accepted", sessionId: abstractId });
    expect(rows[0].status).toBe("sent");
    expect(mailer.sent[0].to).toBe(rows[0].toEmail);
  });

  it("must fire: a radio decline mails the decline template, not the accept one", async () => {
    const mailer = new MemoryMailer();
    await applyAbstractStatus({
      eventId: fixture.eventId,
      abstractId: fixture.abstractIds[3],
      status: "declined",
      origin: ORIGIN,
      mailer,
      db: ctx.db,
    });

    const rows = await decisionRows();
    expect(rows.map((row) => templateKeyOf(row.meta))).toEqual(["decision_decline"]);
  });

  /*
   * The idempotence complement. Re-asserting a decision the row already carries
   * is a no-op click — an organizer re-opening the popover and pressing Save,
   * or a double submit — and a second acceptance email for the same talk is the
   * kind of thing a speaker screenshots.
   */
  it("must NOT fire: re-accepting an already-accepted abstract sends nothing", async () => {
    const abstractId = fixture.abstractIds[3];
    const first = new MemoryMailer();
    await applyAbstractStatus({
      eventId: fixture.eventId,
      abstractId,
      status: "accepted",
      origin: ORIGIN,
      mailer: first,
      db: ctx.db,
    });
    expect(first.sent).toHaveLength(1);

    const second = new MemoryMailer();
    const repeat = await applyAbstractStatus({
      eventId: fixture.eventId,
      abstractId,
      status: "accepted",
      origin: ORIGIN,
      mailer: second,
      db: ctx.db,
    });

    expect(repeat).toMatchObject({ notified: 0, notifyFailed: 0, sessionsComposed: 0 });
    expect(second.sent).toHaveLength(0);
    expect(await decisionRows()).toHaveLength(1);
  });

  it("must NOT fire: an abstract committed through the queue is not re-notified by the radio", async () => {
    const committedId = fixture.abstractIds[2];
    const commitMailer = new MemoryMailer();
    await commitQueues(fixture.eventId, { origin: ORIGIN, mailer: commitMailer, db: ctx.db });
    const afterCommit = await decisionRows();

    const radioMailer = new MemoryMailer();
    const repeat = await applyAbstractStatus({
      eventId: fixture.eventId,
      abstractId: committedId,
      status: "accepted",
      origin: ORIGIN,
      mailer: radioMailer,
      db: ctx.db,
    });

    expect(repeat).toMatchObject({ notified: 0, notifyFailed: 0 });
    expect(radioMailer.sent).toHaveLength(0);
    expect(await decisionRows()).toHaveLength(afterCommit.length);
  });

  it("must NOT fire: queue and pending transitions are not decisions and mail nothing", async () => {
    const mailer = new MemoryMailer();
    for (const status of ["accept_queue", "decline_queue", "pending"] as const) {
      await applyAbstractStatus({
        eventId: fixture.eventId,
        abstractId: fixture.abstractIds[3],
        status,
        origin: ORIGIN,
        mailer,
        db: ctx.db,
      });
    }
    expect(mailer.sent).toHaveLength(0);
    expect(await decisionRows()).toHaveLength(0);
  });
});
