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
  sessions,
} from "~/db/schema";
import { signedInGet, signedInPost } from "~/test/auth";
import { installTestDb, type TestDbContext } from "~/test/db";
import { seedDemoFixture, type DemoFixture } from "~/test/fixtures";
import { commitQueues } from "~/lib/review/commit.server";

import {
  SubmissionDetailView,
  action,
  loader,
  submissionLoaderPayload,
} from "./admin.submission";

type LoaderArgs = Parameters<typeof loader>[0];
type ActionArgs = Parameters<typeof action>[0];

const asLoaderArgs = (request: Request, id: string) =>
  ({ request, params: { id }, context: {} }) as unknown as LoaderArgs;
const asActionArgs = (request: Request, id: string) =>
  ({ request, params: { id }, context: {} }) as unknown as ActionArgs;

let ctx: TestDbContext;
let fixture: DemoFixture;
const ROUND_ONE = "11111111-1111-4111-8111-111111111111";
const TEAM_ONE = "22222222-2222-4222-8222-222222222222";
const NUMERIC_CRITERIA = [
  { key: "relevance", label: "Relevance", min: 1, max: 5, weight: 2 },
  { key: "depth", label: "Technical depth", min: 1, max: 5, weight: 2 },
  { key: "speaker", label: "Speaker signal", min: 1, max: 5, weight: 1 },
];
const SELECT_CRITERION = {
  key: "recommendation",
  label: "Recommendation",
  min: 0,
  max: 0,
  weight: 0,
  type: "select" as const,
  options: ["Accept", "Maybe", "Reject"],
};

beforeEach(async () => {
  ctx = installTestDb();
  fixture = await seedDemoFixture(ctx.db);
  await ctx.db.insert(reviewRounds).values({
    id: ROUND_ONE,
    eventId: fixture.eventId,
    name: "Round 1 — screening",
    ordinal: 1,
    rubric: {
      criteria: NUMERIC_CRITERIA,
    },
  });
  await ctx.db.insert(reviewTeams).values({
    id: TEAM_ONE,
    eventId: fixture.eventId,
    name: "Program committee",
  });
  await ctx.db.insert(reviewTeamMembers).values({
    teamId: TEAM_ONE,
    personId: fixture.adminId,
  });
  await ctx.db.insert(reviewAssignments).values({
    id: "33333333-3333-4333-8333-333333333333",
    roundId: ROUND_ONE,
    sessionId: fixture.abstractIds[3],
    teamId: TEAM_ONE,
  });
});
afterEach(() => ctx.close());

async function load(id: string) {
  const request = await signedInGet(`https://x.test/admin/submissions/${id}?tab=pending`, fixture.adminId);
  return submissionLoaderPayload(await loader(asLoaderArgs(request, id)));
}

async function post(id: string, fields: Record<string, string>) {
  const request = await signedInPost(
    `https://x.test/admin/submissions/${id}`,
    fixture.adminId,
    fields,
  );
  return action(asActionArgs(request, id));
}

describe("multi-round rubric scoring", () => {
  it("must fire: persists a weighted review and returns it from the loader", async () => {
    const target = fixture.abstractIds[3];
    const response = (await post(target, {
      intent: "save-review",
      roundId: ROUND_ONE,
      tab: "pending",
      "score-relevance": "4",
      "score-depth": "5",
      "score-speaker": "3",
      comment: "Strong practical submission.",
    })) as Response;

    expect(response.status).toBe(302);
    const saved = await ctx.db.query.reviews.findFirst({
      where: and(
        eq(reviews.roundId, ROUND_ONE),
        eq(reviews.sessionId, target),
        eq(reviews.reviewerId, fixture.adminId),
      ),
    });
    expect(saved).toMatchObject({
      scores: { relevance: 4, depth: 5, speaker: 3 },
      totalScore: 21,
      comment: "Strong practical submission.",
    });
    expect(saved?.submittedAt).toBeTruthy();

    const data = await load(target);
    expect(data.rounds).toHaveLength(1);
    expect(data.rounds[0].review).toMatchObject({ totalScore: 21 });
  });

  it("must NOT fire: incomplete or out-of-range scorecards write nothing", async () => {
    const target = fixture.abstractIds[3];
    const invalidCases: Record<string, string>[] = [
      {
        intent: "save-review",
        roundId: ROUND_ONE,
        "score-relevance": "4",
        "score-depth": "5",
      },
      {
        intent: "save-review",
        roundId: ROUND_ONE,
        "score-relevance": "6",
        "score-depth": "5",
        "score-speaker": "3",
      },
    ];
    for (const fields of invalidCases) {
      expect(await post(target, fields)).toMatchObject({ ok: false });
    }
    expect(await ctx.db.select().from(reviews)).toHaveLength(0);
  });

  it("must NOT fire: an unassigned reviewer cannot submit an otherwise valid scorecard", async () => {
    const result = await post(fixture.abstractIds[4], {
      intent: "save-review",
      roundId: ROUND_ONE,
      "score-relevance": "4",
      "score-depth": "5",
      "score-speaker": "3",
    });
    expect(result).toEqual({
      ok: false,
      error: "You are not assigned to review this submission in this round.",
    });
    expect(await ctx.db.select().from(reviews)).toHaveLength(0);
  });

  it("creates a second round by cloning the active rubric", async () => {
    const target = fixture.abstractIds[3];
    const response = (await post(target, {
      intent: "create-review-round",
      name: "Round 2 — final selection",
      tab: "pending",
    })) as Response;
    expect(response.status).toBe(302);

    const rounds = await ctx.db
      .select()
      .from(reviewRounds)
      .where(eq(reviewRounds.eventId, fixture.eventId));
    expect(rounds).toHaveLength(2);
    expect(rounds[1]).toMatchObject({
      name: "Round 2 — final selection",
      ordinal: 2,
      rubric: rounds[0].rubric,
    });
    const cloned = await ctx.db
      .select()
      .from(reviewAssignments)
      .where(eq(reviewAssignments.roundId, rounds[1].id));
    expect(cloned).toHaveLength(1);
    expect(cloned[0]).toMatchObject({ sessionId: target, teamId: TEAM_ONE });

    const data = await load(target);
    expect(data.rounds.map((round) => round.ordinal)).toEqual([1, 2]);
  });

  it("aggregates submitted reviewer totals without overwriting the current review", async () => {
    const target = fixture.abstractIds[3];
    await post(target, {
      intent: "save-review",
      roundId: ROUND_ONE,
      "score-relevance": "4",
      "score-depth": "5",
      "score-speaker": "3",
    });

    const secondReviewer = "44444444-4444-4444-8444-444444444444";
    await ctx.db.insert(people).values({
      id: secondReviewer,
      email: "reviewer@example.com",
      fullName: "Second Reviewer",
      role: "admin",
    });
    await ctx.db.insert(reviews).values({
      id: "55555555-5555-4555-8555-555555555555",
      roundId: ROUND_ONE,
      sessionId: target,
      reviewerId: secondReviewer,
      scores: { relevance: 3, depth: 4, speaker: 3 },
      totalScore: 17,
      submittedAt: new Date(),
    });

    const data = await load(target);
    expect(data.rounds[0].review?.totalScore).toBe(21);
    expect(data.rounds[0].aggregate).toEqual({ reviewerCount: 2, averageScore: 19 });
    expect(data.rounds[0].assignedTeams).toEqual(["Program committee"]);
    expect(data.rounds[0].canReview).toBe(true);
  });

  it("must fire: renders a dropdown score and its submitted distribution", async () => {
    const target = fixture.abstractIds[3];
    await ctx.db
      .update(reviewRounds)
      .set({ rubric: { criteria: [...NUMERIC_CRITERIA, SELECT_CRITERION] } })
      .where(eq(reviewRounds.id, ROUND_ONE));
    await post(target, {
      intent: "save-review",
      roundId: ROUND_ONE,
      "score-relevance": "4",
      "score-depth": "5",
      "score-speaker": "3",
      "score-recommendation": "Accept",
    });

    const html = renderToStaticMarkup(<SubmissionDetailView {...(await load(target))} />);
    expect(html).toContain('<select name="score-recommendation"');
    expect(html).not.toMatch(/<input[^>]+name="score-recommendation"/);
    expect(html).toContain('data-testid="round-choices-1"');
    expect(html).toContain("Recommendation: Accept 1 · Maybe 0 · Reject 0 — most common: Accept");
  });

  it("must fire: an all-dropdown round preserves its submitted-review count without an average", async () => {
    const target = fixture.abstractIds[3];
    await ctx.db
      .update(reviewRounds)
      .set({ rubric: { criteria: [SELECT_CRITERION] } })
      .where(eq(reviewRounds.id, ROUND_ONE));
    await post(target, {
      intent: "save-review",
      roundId: ROUND_ONE,
      "score-recommendation": "Accept",
    });

    const data = await load(target);
    expect(data.rounds[0].aggregate).toEqual({ reviewerCount: 1, averageScore: null });
    const html = renderToStaticMarkup(<SubmissionDetailView {...data} />);
    expect(html).toContain("1 submitted");
    expect(html).not.toContain("no submitted reviews");
  });

  it("must NOT fire: a round with zero submitted reviews still says so", async () => {
    const html = renderToStaticMarkup(
      <SubmissionDetailView {...(await load(fixture.abstractIds[3]))} />,
    );

    expect(html).toContain("no submitted reviews");
    expect(html).not.toContain("1 submitted");
  });

  it("must NOT fire: a dropdown criterion cannot change the rendered numeric average", async () => {
    const target = fixture.abstractIds[3];
    await post(target, {
      intent: "save-review",
      roundId: ROUND_ONE,
      "score-relevance": "4",
      "score-depth": "5",
      "score-speaker": "3",
    });
    const numericHtml = renderToStaticMarkup(<SubmissionDetailView {...(await load(target))} />);
    const numericAverage = numericHtml.match(/average [^<]+/)?.[0];

    await ctx.db
      .update(reviewRounds)
      .set({ rubric: { criteria: [...NUMERIC_CRITERIA, SELECT_CRITERION] } })
      .where(eq(reviewRounds.id, ROUND_ONE));
    const dropdownHtml = renderToStaticMarkup(<SubmissionDetailView {...(await load(target))} />);
    const dropdownAverage = dropdownHtml.match(/average [^<]+/)?.[0];

    expect(numericAverage).toBe("average 21.0 / 25");
    expect(dropdownAverage).toBe(numericAverage);
  });

  it("proves two scored rounds transition through the queue into an accepted session", async () => {
    const target = fixture.abstractIds[3];
    const score = {
      intent: "save-review",
      "score-relevance": "4",
      "score-depth": "5",
      "score-speaker": "3",
    };
    await post(target, { ...score, roundId: ROUND_ONE });
    await post(target, { intent: "create-review-round", tab: "pending" });
    const rounds = await ctx.db
      .select()
      .from(reviewRounds)
      .where(eq(reviewRounds.eventId, fixture.eventId));
    await post(target, { ...score, roundId: rounds[1].id });
    await post(target, {
      intent: "set-status",
      sessionId: target,
      status: "accept_queue",
      tab: "pending",
    });

    await commitQueues(fixture.eventId);
    const accepted = await ctx.db.query.sessions.findFirst({ where: eq(sessions.id, target) });
    expect(accepted).toMatchObject({ status: "accepted" });
    expect(accepted?.composedIntoSessionId).toBeTruthy();

    const submitted = await ctx.db
      .select()
      .from(reviews)
      .where(eq(reviews.sessionId, target));
    expect(submitted).toHaveLength(2);
    expect(submitted.every((review) => review.totalScore === 21)).toBe(true);
  });

  it("renders an independent scorecard for every round", async () => {
    const target = fixture.abstractIds[3];
    await post(target, { intent: "create-review-round", tab: "pending" });
    const html = renderToStaticMarkup(<SubmissionDetailView {...(await load(target))} />);

    expect(html).toContain("Review scorecards");
    expect(html).toContain('data-testid="review-round-1"');
    expect(html).toContain('data-testid="review-round-2"');
    expect(html.match(/name="score-relevance"/g)).toHaveLength(2);
  });
});
