/**
 * DB-backed proof for "commit queues": both directions must fire, and the rows
 * the commit must NOT touch are asserted by value, not by absence of a crash.
 */
import { and, eq, inArray } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { reviewRounds, sessionParticipants, sessions, tasks } from "~/db/schema";
import { installTestDb, type TestDbContext } from "~/test/db";
import { seedDemoFixture, type DemoFixture } from "~/test/fixtures";

import { commitQueues } from "./commit.server";

let ctx: TestDbContext;
let fixture: DemoFixture;

beforeEach(async () => {
  ctx = installTestDb();
  fixture = await seedDemoFixture(ctx.db);
});
afterEach(() => ctx.close());

/** Fixture mirrors the seed: index 2 is the only accept_queue row, 5 the only decline_queue. */
const QUEUED_ACCEPT = 2;
const QUEUED_DECLINE = 5;
const PENDING = [3, 4];

describe("commitQueues", () => {
  it("must fire: accept queue -> accepted, with a composed session and portal tasks", async () => {
    const result = await commitQueues(fixture.eventId);

    expect(result.accepted).toBe(1);
    expect(result.sessionsComposed).toBe(1);
    // 4 task templates x 1 speaker on the accepted abstract
    expect(result.tasksCreated).toBe(4);

    const abstract = await ctx.db.query.sessions.findFirst({
      where: eq(sessions.id, fixture.abstractIds[QUEUED_ACCEPT]),
    });
    expect(abstract?.status).toBe("accepted");
    expect(abstract?.composedIntoSessionId).toBeTruthy();

    const program = await ctx.db.query.sessions.findFirst({
      where: eq(sessions.id, abstract!.composedIntoSessionId!),
    });
    expect(program).toBeDefined();
    expect(program?.isAbstract).toBe(false);
    expect(program?.title).toBe(abstract?.title);
    expect(program?.trackId).toBe(abstract?.trackId);
    // Unscheduled on purpose — the agenda builder places it.
    expect(program?.startsAt).toBeNull();

    const carried = await ctx.db
      .select()
      .from(sessionParticipants)
      .where(eq(sessionParticipants.sessionId, program!.id));
    expect(carried.map((row) => row.personId)).toEqual([fixture.speakerIds[QUEUED_ACCEPT]]);

    const created = await ctx.db
      .select()
      .from(tasks)
      .where(
        and(
          eq(tasks.personId, fixture.speakerIds[QUEUED_ACCEPT]),
          eq(tasks.sessionId, program!.id),
        ),
      );
    expect(created).toHaveLength(4);
    expect(created.every((task) => task.status === "pending")).toBe(true);
    expect(created.map((task) => task.title).sort()).toEqual([
      "Complete your bio",
      "Confirm your slot",
      "Submit your slides",
      "Upload a headshot",
    ]);
  });

  it("must fire: decline queue -> declined", async () => {
    const result = await commitQueues(fixture.eventId);
    expect(result.declined).toBe(1);

    const declined = await ctx.db.query.sessions.findFirst({
      where: eq(sessions.id, fixture.abstractIds[QUEUED_DECLINE]),
    });
    expect(declined?.status).toBe("declined");
    // A decline composes nothing and creates no tasks.
    expect(declined?.composedIntoSessionId).toBeNull();
  });

  it("must NOT fire: pending rows are untouched — no status change, no session, no tasks", async () => {
    const tasksBefore = await ctx.db.select().from(tasks);
    const sessionsBefore = await ctx.db.select().from(sessions);

    const result = await commitQueues(fixture.eventId);
    expect(result.untouched).toBe(6); // 2 accepted, 2 pending, 1 declined, 1 withdrawn

    const pendingRows = await ctx.db
      .select()
      .from(sessions)
      .where(inArray(sessions.id, PENDING.map((i) => fixture.abstractIds[i])));
    expect(pendingRows.map((row) => row.status)).toEqual(["pending", "pending"]);
    expect(pendingRows.every((row) => row.composedIntoSessionId === null)).toBe(true);

    const pendingTasks = await ctx.db
      .select()
      .from(tasks)
      .where(inArray(tasks.personId, PENDING.map((i) => fixture.speakerIds[i])));
    expect(pendingTasks).toHaveLength(0);

    // Exactly one new session (the composed one) and exactly four new tasks.
    const sessionsAfter = await ctx.db.select().from(sessions);
    const tasksAfter = await ctx.db.select().from(tasks);
    expect(sessionsAfter.length - sessionsBefore.length).toBe(1);
    expect(tasksAfter.length - tasksBefore.length).toBe(4);
  });

  it("must NOT fire: withdrawn and already-declined rows keep their status", async () => {
    await commitQueues(fixture.eventId);
    const withdrawn = await ctx.db.query.sessions.findFirst({
      where: eq(sessions.id, fixture.abstractIds[7]),
    });
    const alreadyDeclined = await ctx.db.query.sessions.findFirst({
      where: eq(sessions.id, fixture.abstractIds[6]),
    });
    expect(withdrawn?.status).toBe("withdrawn");
    expect(alreadyDeclined?.status).toBe("declined");
    expect(alreadyDeclined?.composedIntoSessionId).toBeNull();
  });

  it("creates the review round on first commit and reuses it after", async () => {
    const first = await commitQueues(fixture.eventId);
    expect(first.roundCreated).toBe(true);

    const rounds = await ctx.db
      .select()
      .from(reviewRounds)
      .where(eq(reviewRounds.eventId, fixture.eventId));
    expect(rounds).toHaveLength(1);
    expect(rounds[0].ordinal).toBe(1);

    const second = await commitQueues(fixture.eventId);
    expect(second.roundCreated).toBe(false);
    expect(second.roundId).toBe(first.roundId);

    const roundsAfter = await ctx.db
      .select()
      .from(reviewRounds)
      .where(eq(reviewRounds.eventId, fixture.eventId));
    expect(roundsAfter).toHaveLength(1);
  });

  it("is a no-op the second time — no duplicate sessions or tasks", async () => {
    await commitQueues(fixture.eventId);
    const sessionsAfterFirst = await ctx.db.select().from(sessions);
    const tasksAfterFirst = await ctx.db.select().from(tasks);

    const second = await commitQueues(fixture.eventId);
    expect(second.accepted).toBe(0);
    expect(second.declined).toBe(0);
    expect(second.tasksCreated).toBe(0);

    expect(await ctx.db.select().from(sessions)).toHaveLength(sessionsAfterFirst.length);
    expect(await ctx.db.select().from(tasks)).toHaveLength(tasksAfterFirst.length);
  });

  it("commits 100 queued rows through chunked batches", async () => {
    // 60 accepts + 40 declines, well past the ~100 bound-parameter cap and the
    // per-batch statement chunk size.
    const bulk = Array.from({ length: 100 }, (_, index) => ({
      id: `bulk-${index}`,
      eventId: fixture.eventId,
      friendlyId: `BULK-${index}`,
      title: `Bulk abstract ${index}`,
      status: (index < 60 ? "accept_queue" : "decline_queue") as
        | "accept_queue"
        | "decline_queue",
      isAbstract: true,
    }));
    for (let i = 0; i < bulk.length; i += 5) {
      await ctx.db.insert(sessions).values(bulk.slice(i, i + 5));
    }
    for (let i = 0; i < bulk.length; i += 5) {
      await ctx.db.insert(sessionParticipants).values(
        bulk.slice(i, i + 5).map((row) => ({
          sessionId: row.id,
          personId: fixture.speakerIds[0],
          role: "speaker" as const,
          isPrimary: true,
        })),
      );
    }

    const result = await commitQueues(fixture.eventId);
    expect(result.accepted).toBe(61); // 60 bulk + the seeded one
    expect(result.declined).toBe(41);
    expect(result.sessionsComposed).toBe(61);
    expect(result.tasksCreated).toBe(61 * 4);

    const stillQueued = await ctx.db
      .select()
      .from(sessions)
      .where(
        and(
          eq(sessions.eventId, fixture.eventId),
          inArray(sessions.status, ["accept_queue", "decline_queue"]),
        ),
      );
    expect(stillQueued).toHaveLength(0);
  });
});
