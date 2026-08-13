import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  reviewAssignments,
  reviewRounds,
  reviews,
  reviewTeamMembers,
  reviewTeams,
} from "~/db/schema";
import { listComms } from "~/lib/comms/comm-log.server";
import { MemoryMailer } from "~/lib/mail/mailer";
import type { Mailer } from "~/lib/mail/mailer";
import { installTestDb, type TestDbContext } from "~/test/db";
import {
  FIXTURE_NOW,
  seedDemoFixture,
  seedOtherEvent,
  type DemoFixture,
} from "~/test/fixtures";

import { sendReviewReminders } from "./reminders.server";

let ctx: TestDbContext;
let fixture: DemoFixture;

beforeEach(async () => {
  ctx = installTestDb();
  fixture = await seedDemoFixture(ctx.db);
});
afterEach(() => ctx.close());

const ROUND_ID = "reminder-round-0000-4000-8000-000000000001";
const LAGGING_TEAM = "reminder-team-0000-4000-8000-000000000001";
const COMPLETE_TEAM = "reminder-team-0000-4000-8000-000000000002";

async function seedRound(includeCompleteReviewer = false) {
  await ctx.db.insert(reviewRounds).values({
    id: ROUND_ID,
    eventId: fixture.eventId,
    name: "Final selection",
    ordinal: 1,
  });
  await ctx.db.insert(reviewTeams).values([
    { id: LAGGING_TEAM, eventId: fixture.eventId, name: "Lagging team" },
    ...(includeCompleteReviewer
      ? [{ id: COMPLETE_TEAM, eventId: fixture.eventId, name: "Complete team" }]
      : []),
  ]);
  await ctx.db.insert(reviewTeamMembers).values([
    { teamId: LAGGING_TEAM, personId: fixture.adminId },
    ...(includeCompleteReviewer
      ? [{ teamId: COMPLETE_TEAM, personId: fixture.speakerIds[0] }]
      : []),
  ]);
  await ctx.db.insert(reviewAssignments).values([
    {
      id: "reminder-assignment-0000-4000-8000-000000000001",
      roundId: ROUND_ID,
      teamId: LAGGING_TEAM,
      sessionId: fixture.abstractIds[3],
    },
    {
      id: "reminder-assignment-0000-4000-8000-000000000002",
      roundId: ROUND_ID,
      teamId: LAGGING_TEAM,
      sessionId: fixture.abstractIds[4],
    },
    ...(includeCompleteReviewer
      ? [
          {
            id: "reminder-assignment-0000-4000-8000-000000000003",
            roundId: ROUND_ID,
            teamId: COMPLETE_TEAM,
            sessionId: fixture.abstractIds[3],
          },
          {
            id: "reminder-assignment-0000-4000-8000-000000000004",
            roundId: ROUND_ID,
            teamId: COMPLETE_TEAM,
            sessionId: fixture.abstractIds[4],
          },
        ]
      : []),
  ]);
  if (includeCompleteReviewer) {
    await ctx.db.insert(reviews).values(
      [fixture.abstractIds[3], fixture.abstractIds[4]].map((sessionId) => ({
        roundId: ROUND_ID,
        sessionId,
        reviewerId: fixture.speakerIds[0],
        submittedAt: new Date(FIXTURE_NOW),
      })),
    );
  }
}

async function run<T extends Mailer = MemoryMailer>(mailer?: T) {
  const selected = mailer ?? (new MemoryMailer() as unknown as T);
  const result = await sendReviewReminders({
    eventId: fixture.eventId,
    roundId: ROUND_ID,
    db: ctx.db,
    mailer: selected,
    now: new Date(FIXTURE_NOW),
    origin: "https://callboard.test",
  });
  return { result, mailer: selected };
}

describe("sendReviewReminders", () => {
  it("must fire once for a reviewer with two assigned and none complete", async () => {
    await seedRound();
    const { result, mailer } = await run();

    expect(result).toEqual({
      candidates: 1,
      sent: 1,
      failed: 0,
      recipients: ["admin@callboard.dev"],
    });
    expect(mailer.sent).toHaveLength(1);
    expect(mailer.sent[0].text).toContain("Ada Organiser");
    expect(mailer.sent[0].text).toContain("Frontier AI Summit 2026");
    expect(mailer.sent[0].text).toContain("Final selection");
    expect(mailer.sent[0].text).toContain("2 review(s) outstanding");
    expect(mailer.sent[0].text).toContain("https://callboard.test/review");

    const rows = await listComms({ eventId: fixture.eventId, db: ctx.db });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      status: "sent",
      templateKey: "review_reminder",
      meta: {
        templateKey: "review_reminder",
        roundId: ROUND_ID,
        outstandingCount: 2,
      },
    });
  });

  it("must not fire for a completed reviewer beside a lagging reviewer", async () => {
    await seedRound(true);
    const { result, mailer } = await run();

    expect(result.sent).toBe(1);
    expect(mailer.sent.map((message) => message.to)).toEqual(["admin@callboard.dev"]);
    const completedRows = await listComms({
      eventId: fixture.eventId,
      personId: fixture.speakerIds[0],
      db: ctx.db,
    });
    expect(completedRows).toHaveLength(0);
  });

  it("must not fire when the only remaining assignment was recused", async () => {
    await seedRound();
    await ctx.db.insert(reviews).values([
      {
        roundId: ROUND_ID,
        sessionId: fixture.abstractIds[3],
        reviewerId: fixture.adminId,
        recusedAt: new Date(FIXTURE_NOW),
      },
      {
        roundId: ROUND_ID,
        sessionId: fixture.abstractIds[4],
        reviewerId: fixture.adminId,
        submittedAt: new Date(FIXTURE_NOW),
      },
    ]);

    const { result, mailer } = await run();
    expect(result).toEqual({ candidates: 0, sent: 0, failed: 0, recipients: [] });
    expect(mailer.sent).toHaveLength(0);
    expect(await listComms({ eventId: fixture.eventId, db: ctx.db })).toHaveLength(0);
  });

  it("must not include reviewers or assignments from another event", async () => {
    await seedRound();
    const other = await seedOtherEvent(ctx.db);
    await ctx.db.insert(reviewAssignments).values({
      id: "other-reminder-assignment-0000-4000-8000-000000000001",
      roundId: other.roundId,
      teamId: other.teamId,
      sessionId: other.abstractIds[1],
    });

    const { result, mailer } = await run();
    expect(result.sent).toBe(1);
    expect(result.candidates).toBe(1);
    expect(mailer.sent).toHaveLength(1);
    expect(mailer.sent[0].text).not.toContain(other.name);
  });

  it("must log a returned mailer failure and report it as failed", async () => {
    await seedRound();
    const failing = {
      name: "failing",
      observesDelivery: true,
      async send() {
        return { ok: false as const, error: "provider rejected reminder" };
      },
    };

    const { result } = await run(failing);
    expect(result).toMatchObject({ candidates: 1, sent: 0, failed: 1 });
    const rows = await listComms({ eventId: fixture.eventId, db: ctx.db });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      status: "failed",
      templateKey: "review_reminder",
    });
    expect(rows[0].error).toContain("provider rejected reminder");
  });

  it("returns no candidates when the round belongs to another event", async () => {
    await seedRound();
    const other = await seedOtherEvent(ctx.db);
    const mailer = new MemoryMailer();
    const result = await sendReviewReminders({
      eventId: fixture.eventId,
      roundId: other.roundId,
      db: ctx.db,
      mailer,
      origin: "https://callboard.test",
    });
    expect(result).toEqual({ candidates: 0, sent: 0, failed: 0, recipients: [] });
    expect(mailer.sent).toHaveLength(0);
  });
});
