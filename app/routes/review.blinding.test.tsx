/**
 * Reviewer blinding is a wire boundary, not a presentation trick.
 *
 * React Router serialises loader data into the SSR document for hydration. A
 * component that merely declines to render identity still leaks it in source,
 * so the must-fire assertions below execute the real loaders and inspect their
 * serialised payloads. The neighbouring must-NOT-fire controls prove that the
 * abstract, scoring workflow, organizer identity, and rubric writes survive.
 */
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
import { isRoundBlind } from "~/lib/review/scoring";
import { signedInGet, signedInPost } from "~/test/auth";
import { installTestDb, type TestDbContext } from "~/test/db";
import {
  seedDemoFixture,
  seedOtherEvent,
  type DemoFixture,
} from "~/test/fixtures";

import { loader as adminSubmissionLoader } from "./admin.submission";
import {
  action as adminReviewsAction,
  loader as adminReviewsLoader,
} from "./admin.reviews";
import {
  ReviewerWorkspaceView,
  loader as reviewLoader,
} from "./review.index";

const ROUND_ID = "91000000-0000-4000-8000-000000000001";
const TEAM_ID = "91000000-0000-4000-8000-000000000002";
const ASSIGNMENT_ID = "91000000-0000-4000-8000-000000000003";

type ReviewLoaderArgs = Parameters<typeof reviewLoader>[0];
type AdminReviewsLoaderArgs = Parameters<typeof adminReviewsLoader>[0];
type AdminReviewsActionArgs = Parameters<typeof adminReviewsAction>[0];
type AdminSubmissionLoaderArgs = Parameters<typeof adminSubmissionLoader>[0];

const reviewArgs = (request: Request) =>
  ({ request, params: {}, context: {} }) as unknown as ReviewLoaderArgs;
const adminReviewsLoadArgs = (request: Request) =>
  ({ request, params: {}, context: {} }) as unknown as AdminReviewsLoaderArgs;
const adminReviewsActionArgs = (request: Request) =>
  ({ request, params: {}, context: {} }) as unknown as AdminReviewsActionArgs;
const adminSubmissionArgs = (request: Request, id: string) =>
  ({ request, params: { id }, context: {} }) as unknown as AdminSubmissionLoaderArgs;

let ctx: TestDbContext;
let fixture: DemoFixture;

beforeEach(async () => {
  ctx = installTestDb();
  fixture = await seedDemoFixture(ctx.db);
  await ctx.db.insert(reviewTeams).values({
    id: TEAM_ID,
    eventId: fixture.eventId,
    name: "Blind review team",
  });
  await ctx.db.insert(reviewTeamMembers).values({
    teamId: TEAM_ID,
    personId: fixture.adminId,
  });
  await ctx.db.insert(reviewRounds).values({
    id: ROUND_ID,
    eventId: fixture.eventId,
    name: "Screening",
    ordinal: 1,
    rubric: {
      criteria: [{ key: "fit", label: "Programme fit", min: 1, max: 5, weight: 1 }],
    },
    opensAt: new Date(Date.now() - 60_000),
    closesAt: new Date(Date.now() + 60_000),
  });
  // The first abstract has a primary and co-speaker, which pins the count-only
  // projection as well as identity ordering.
  await ctx.db.insert(reviewAssignments).values({
    id: ASSIGNMENT_ID,
    roundId: ROUND_ID,
    sessionId: fixture.abstractIds[0],
    teamId: TEAM_ID,
  });
});

afterEach(() => ctx.close());

const wire = (payload: unknown): string => JSON.stringify(payload);

async function primarySpeaker() {
  const speaker = await ctx.db.query.people.findFirst({
    where: eq(people.id, fixture.speakerIds[0]),
  });
  if (!speaker) throw new Error("Seeded primary speaker is missing.");
  return speaker;
}

async function loadReview() {
  return reviewLoader(
    reviewArgs(await signedInGet("https://x.test/review", fixture.adminId)),
  );
}

async function postAdminReviews(fields: Record<string, string>) {
  return adminReviewsAction(
    adminReviewsActionArgs(
      await signedInPost("https://x.test/admin/reviews", fixture.adminId, fields),
    ),
  );
}

async function setBlind(blind = true) {
  await postAdminReviews({
    intent: "set-round-blinding",
    roundId: ROUND_ID,
    ...(blind ? { blind: "on" } : {}),
  });
}

describe("per-round reviewer blinding at the wire", () => {
  it("must fire: an unblinded reviewer payload contains the primary speaker identity", async () => {
    const speaker = await primarySpeaker();
    const payload = await loadReview();

    expect(payload.assignments[0].blind).toBe(false);
    expect(wire(payload)).toContain(speaker.fullName);
    expect(wire(payload)).not.toContain(speaker.email);
    expect(payload.assignments[0].speakerCount).toBe(2);
  });

  it("must fire: a blinded reviewer payload omits every primary identity field", async () => {
    const speaker = await primarySpeaker();
    await setBlind();

    const payload = await loadReview();
    const serialised = wire(payload);
    expect(payload.assignments[0]).toMatchObject({
      blind: true,
      speakers: [],
      speakerCount: 2,
    });
    expect(serialised).not.toContain(speaker.fullName);
    expect(serialised).not.toContain(speaker.email);
    expect(serialised).not.toContain(speaker.company);
    expect(serialised).not.toContain(speaker.title);
    expect(serialised).not.toContain("Jonas Weir");
    expect(serialised).not.toContain("jonas@example.com");
  });

  it("must NOT fire: blinding the reviewer leaves organizer identity visible", async () => {
    const speaker = await primarySpeaker();
    await setBlind();

    const payload = await adminSubmissionLoader(
      adminSubmissionArgs(
        await signedInGet(
          `https://x.test/admin/submissions/${fixture.abstractIds[0]}`,
          fixture.adminId,
        ),
        fixture.abstractIds[0],
      ),
    );
    expect(wire(payload)).toContain(speaker.fullName);
    expect(wire(payload)).toContain(speaker.email);
  });

  it("must NOT fire: a blinded reviewer still receives the abstract and scorecard", async () => {
    await setBlind();
    const payload = await loadReview();
    const html = renderToStaticMarkup(
      <ReviewerWorkspaceView loaderData={payload} actionData={undefined} />,
    );

    expect(html).toContain("Shipping agents that survive contact with users. Seeded abstract body for the demo.");
    expect(html).toContain('data-testid="reviewer-scorecard"');
    expect(html).toContain('name="score-fit"');
    expect(html).toContain("Blind review");
    expect(html).toContain("2 speakers");
  });

  it("must NOT fire: saving rubric criteria preserves a blinded round", async () => {
    await setBlind();
    await postAdminReviews({
      intent: "save-rubric",
      roundId: ROUND_ID,
      criterionKey: "impact",
      criterionLabel: "Audience impact",
      criterionMin: "0",
      criterionMax: "10",
      criterionWeight: "2",
    });

    const round = await ctx.db.query.reviewRounds.findFirst({
      where: eq(reviewRounds.id, ROUND_ID),
    });
    expect(isRoundBlind(round?.rubric)).toBe(true);
    expect(round?.rubric).toMatchObject({
      criteria: [{ key: "impact", label: "Audience impact", min: 0, max: 10, weight: 2 }],
    });
  });

  it("must NOT fire: new and legacy rounds default to unblinded", async () => {
    const legacyPayload = await loadReview();
    expect(legacyPayload.assignments[0].blind).toBe(false);
    expect(isRoundBlind((await ctx.db.query.reviewRounds.findFirst({
      where: eq(reviewRounds.id, ROUND_ID),
    }))?.rubric)).toBe(false);

    await postAdminReviews({ intent: "create-round", name: "Round 2" });
    const created = await ctx.db.query.reviewRounds.findFirst({
      where: and(eq(reviewRounds.eventId, fixture.eventId), eq(reviewRounds.name, "Round 2")),
    });
    expect(created).toBeDefined();
    expect(created?.rubric).not.toHaveProperty("blind");
    expect(isRoundBlind(created?.rubric)).toBe(false);

    const adminPayload = await adminReviewsLoader(
      adminReviewsLoadArgs(
        await signedInGet("https://x.test/admin/reviews", fixture.adminId),
      ),
    );
    expect(adminPayload.rounds.find((round) => round.id === created?.id)?.blind).toBe(false);
  });

  it("must NOT fire: the blinding action cannot update another event's round", async () => {
    const other = await seedOtherEvent(ctx.db);
    expect(await postAdminReviews({
      intent: "set-round-blinding",
      roundId: other.roundId,
      blind: "on",
    })).toEqual({ ok: false, error: "That review round does not belong to this event." });
    const otherRound = await ctx.db.query.reviewRounds.findFirst({
      where: eq(reviewRounds.id, other.roundId),
    });
    expect(isRoundBlind(otherRound?.rubric)).toBe(false);
  });

  it("must NOT fire: blinding remains changeable after a submitted review", async () => {
    await setBlind();
    await ctx.db.insert(reviews).values({
      id: "91000000-0000-4000-8000-000000000004",
      roundId: ROUND_ID,
      sessionId: fixture.abstractIds[0],
      reviewerId: fixture.adminId,
      scores: { fit: 4 },
      totalScore: 4,
      submittedAt: new Date(),
    });

    await setBlind(false);
    const round = await ctx.db.query.reviewRounds.findFirst({
      where: eq(reviewRounds.id, ROUND_ID),
    });
    expect(isRoundBlind(round?.rubric)).toBe(false);
  });
});
