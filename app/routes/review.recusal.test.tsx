import { renderToStaticMarkup } from "react-dom/server";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  people,
  reviewAssignments,
  reviewRounds,
  reviews,
  reviewTeamMembers,
  reviewTeams,
} from "~/db/schema";
import { signedInGet, signedInPost } from "~/test/auth";
import { installTestDb, type TestDbContext } from "~/test/db";
import { seedDemoFixture, type DemoFixture } from "~/test/fixtures";

import {
  ReviewOperationsView,
  loader as adminReviewsLoader,
} from "./admin.reviews";
import {
  action as reviewAction,
  loader as reviewLoader,
} from "./review.index";

const REVIEWER_ONE = "92000000-0000-4000-8000-000000000001";
const REVIEWER_TWO = "92000000-0000-4000-8000-000000000002";
const TEAM_ID = "92000000-0000-4000-8000-000000000003";
const ROUND_ONE = "92000000-0000-4000-8000-000000000004";
const ASSIGNMENT_ONE = "92000000-0000-4000-8000-000000000005";
const ROUND_TWO = "92000000-0000-4000-8000-000000000006";
const ASSIGNMENT_TWO = "92000000-0000-4000-8000-000000000007";

type ReviewLoaderArgs = Parameters<typeof reviewLoader>[0];
type ReviewActionArgs = Parameters<typeof reviewAction>[0];
type AdminReviewsLoaderArgs = Parameters<typeof adminReviewsLoader>[0];

const reviewLoadArgs = (request: Request) =>
  ({ request, params: {}, context: {} }) as unknown as ReviewLoaderArgs;
const reviewActionArgs = (request: Request) =>
  ({ request, params: {}, context: {} }) as unknown as ReviewActionArgs;
const adminLoadArgs = (request: Request) =>
  ({ request, params: {}, context: {} }) as unknown as AdminReviewsLoaderArgs;

let ctx: TestDbContext;
let fixture: DemoFixture;

beforeEach(async () => {
  ctx = installTestDb();
  fixture = await seedDemoFixture(ctx.db);
  await ctx.db.insert(people).values([
    {
      id: REVIEWER_ONE,
      email: "ren.recusal@example.com",
      fullName: "Ren Recusal",
      role: "speaker",
    },
    {
      id: REVIEWER_TWO,
      email: "sky.scorer@example.com",
      fullName: "Sky Scorer",
      role: "speaker",
    },
  ]);
  await ctx.db.insert(reviewTeams).values({
    id: TEAM_ID,
    eventId: fixture.eventId,
    name: "Conflict controls",
  });
  await ctx.db.insert(reviewTeamMembers).values([
    { teamId: TEAM_ID, personId: REVIEWER_ONE },
    { teamId: TEAM_ID, personId: REVIEWER_TWO },
  ]);
  await ctx.db.insert(reviewRounds).values({
    id: ROUND_ONE,
    eventId: fixture.eventId,
    name: "Conflict screening",
    ordinal: 1,
    rubric: {
      criteria: [{ key: "fit", label: "Programme fit", min: 1, max: 5, weight: 1 }],
    },
    opensAt: new Date(Date.now() - 60_000),
    closesAt: new Date(Date.now() + 60_000),
  });
  await ctx.db.insert(reviewAssignments).values({
    id: ASSIGNMENT_ONE,
    roundId: ROUND_ONE,
    sessionId: fixture.abstractIds[0],
    teamId: TEAM_ID,
  });
});

afterEach(() => ctx.close());

async function loadReview(personId = REVIEWER_ONE) {
  return reviewLoader(
    reviewLoadArgs(await signedInGet("https://x.test/review", personId)),
  );
}

async function postReview(
  personId: string,
  fields: Record<string, string>,
) {
  return reviewAction(
    reviewActionArgs(
      await signedInPost("https://x.test/review", personId, fields),
    ),
  );
}

async function declareConflict(
  personId = REVIEWER_ONE,
  roundId = ROUND_ONE,
  sessionId = fixture.abstractIds[0],
) {
  return postReview(personId, {
    intent: "declare-conflict",
    roundId,
    sessionId,
  });
}

async function saveReview(
  personId = REVIEWER_ONE,
  roundId = ROUND_ONE,
  sessionId = fixture.abstractIds[0],
) {
  return postReview(personId, {
    intent: "save-review",
    roundId,
    sessionId,
    "score-fit": "5",
  });
}

async function loadAdminReviews() {
  return adminReviewsLoader(
    adminLoadArgs(
      await signedInGet("https://x.test/admin/reviews", fixture.adminId),
    ),
  );
}

async function reviewerOneRow() {
  return ctx.db.query.reviews.findFirst({
    where: and(
      eq(reviews.roundId, ROUND_ONE),
      eq(reviews.sessionId, fixture.abstractIds[0]),
      eq(reviews.reviewerId, REVIEWER_ONE),
    ),
  });
}

describe("reviewer conflict recusals", () => {
  it("must fire: declaring a conflict removes the abstract from that reviewer's loader payload", async () => {
    const response = await declareConflict();
    expect(response).toBeInstanceOf(Response);
    expect((response as Response).status).toBe(302);
    expect((response as Response).headers.get("location")).toBe("/review?event=frontier-ai-summit-2026");

    const payload = await loadReview();
    expect(payload.assignments).toEqual([]);
  });

  it("must fire: a reviewer cannot score an abstract after recusing", async () => {
    await declareConflict();

    expect(await saveReview()).toEqual({
      ok: false,
      error: "You declared a conflict on this abstract.",
    });
    expect(await reviewerOneRow()).toMatchObject({
      scores: null,
      totalScore: null,
      submittedAt: null,
    });
  });

  it("must NOT fire: another reviewer on the same team still sees and scores the abstract", async () => {
    await declareConflict();

    expect((await loadReview(REVIEWER_TWO)).assignments.map((row) => row.sessionId)).toEqual([
      fixture.abstractIds[0],
    ]);
    expect(await saveReview(REVIEWER_TWO)).toBeInstanceOf(Response);
    const scored = await ctx.db.query.reviews.findFirst({
      where: and(
        eq(reviews.roundId, ROUND_ONE),
        eq(reviews.sessionId, fixture.abstractIds[0]),
        eq(reviews.reviewerId, REVIEWER_TWO),
      ),
    });
    expect(scored).toMatchObject({ totalScore: 5 });
    expect(scored?.submittedAt).toBeInstanceOf(Date);
  });

  it("must NOT fire: a recusal in one round leaves the same abstract in another open round", async () => {
    await ctx.db.insert(reviewRounds).values({
      id: ROUND_TWO,
      eventId: fixture.eventId,
      name: "Final screening",
      ordinal: 2,
      rubric: {
        criteria: [{ key: "fit", label: "Programme fit", min: 1, max: 5, weight: 1 }],
      },
      opensAt: new Date(Date.now() - 60_000),
      closesAt: new Date(Date.now() + 60_000),
    });
    await ctx.db.insert(reviewAssignments).values({
      id: ASSIGNMENT_TWO,
      roundId: ROUND_TWO,
      sessionId: fixture.abstractIds[0],
      teamId: TEAM_ID,
    });
    await declareConflict();

    expect((await loadReview()).assignments.map((row) => ({
      roundId: row.roundId,
      sessionId: row.sessionId,
    }))).toEqual([{ roundId: ROUND_TWO, sessionId: fixture.abstractIds[0] }]);
  });

  it("must NOT fire: a recusal is not counted as a completed review", async () => {
    await saveReview();
    await declareConflict();

    const payload = await loadAdminReviews();
    expect(payload.rounds.find((round) => round.id === ROUND_ONE)).toMatchObject({
      submittedReviews: 0,
      progress: { completedReviews: 0 },
    });
  });

  it("must NOT fire: the organizer sees the reviewer's recusal on the assignment", async () => {
    await declareConflict();

    const payload = await loadAdminReviews();
    expect(payload.recusals).toContainEqual({
      roundId: ROUND_ONE,
      sessionId: fixture.abstractIds[0],
      reviewerName: "Ren Recusal",
      reviewerEmail: "ren.recusal@example.com",
    });
    const html = renderToStaticMarkup(<ReviewOperationsView {...payload} />);
    expect(html).toContain("Recused: Ren Recusal");
  });

  it("must NOT fire: declaring a conflict on an unassigned abstract writes nothing", async () => {
    expect(await declareConflict(REVIEWER_ONE, ROUND_ONE, fixture.abstractIds[1])).toEqual({
      ok: false,
      error: "That abstract is not assigned to you in an open round.",
    });
    expect(await ctx.db.select().from(reviews)).toEqual([]);
  });
});
