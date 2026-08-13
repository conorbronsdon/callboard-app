import { renderToStaticMarkup } from "react-dom/server";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  events,
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

import { ReviewerPreviewTable } from "./admin.viewas";
import { ReviewerWorkspaceView, action, loader } from "./review.index";

type LoaderArgs = Parameters<typeof loader>[0];
type ActionArgs = Parameters<typeof action>[0];
const loaderArgs = (request: Request) => ({ request, params: {}, context: {} }) as unknown as LoaderArgs;
const actionArgs = (request: Request) => ({ request, params: {}, context: {} }) as unknown as ActionArgs;

const REVIEWER = "90000000-0000-4000-8000-000000000001";
const OUTSIDER = "90000000-0000-4000-8000-000000000002";
const TEAM = "90000000-0000-4000-8000-000000000003";
const OPEN_ROUND = "90000000-0000-4000-8000-000000000004";
const NON_MEMBER = "90000000-0000-4000-8000-000000000017";
const OTHER_TEAM = "90000000-0000-4000-8000-000000000018";

let ctx: TestDbContext;
let fixture: DemoFixture;

beforeEach(async () => {
  ctx = installTestDb();
  fixture = await seedDemoFixture(ctx.db);
  await ctx.db.insert(people).values([
    { id: REVIEWER, email: "reviewer@example.com", fullName: "Rae Reviewer", role: "speaker" },
    { id: OUTSIDER, email: "outsider@example.com", fullName: "Ollie Outsider", role: "speaker" },
    { id: NON_MEMBER, email: "nonmember@example.com", fullName: "Nia Nonmember", role: "speaker" },
  ]);
  await ctx.db.insert(reviewTeams).values([
    { id: TEAM, eventId: fixture.eventId, name: "Agents reviewers" },
    { id: OTHER_TEAM, eventId: fixture.eventId, name: "Evals reviewers" },
  ]);
  await ctx.db.insert(reviewTeamMembers).values([
    { teamId: TEAM, personId: REVIEWER },
    { teamId: OTHER_TEAM, personId: OUTSIDER },
  ]);
  await ctx.db.insert(reviewRounds).values({
    id: OPEN_ROUND,
    eventId: fixture.eventId,
    name: "Screening",
    ordinal: 1,
    rubric: { criteria: [
      { key: "fit", label: "Programme fit", min: 1, max: 5, weight: 2 },
      { key: "clarity", label: "Clarity", min: 1, max: 5, weight: 1 },
    ] },
    opensAt: new Date(Date.now() - 60_000),
    closesAt: new Date(Date.now() + 60_000),
  });
  await ctx.db.insert(reviewAssignments).values({
    id: "90000000-0000-4000-8000-000000000005",
    roundId: OPEN_ROUND,
    sessionId: fixture.abstractIds[3],
    teamId: TEAM,
  });
});

describe("reviewer preview table accessibility", () => {
  it("renders scoped column headers and a named action column", () => {
    const html = renderToStaticMarkup(
      <ReviewerPreviewTable
        reviewers={[
          {
            id: "reviewer-1",
            email: "reviewer@example.com",
            fullName: "Rae Reviewer",
            teams: ["Agents", "Evals"],
          },
        ]}
      />,
    );

    expect(html.match(/scope="col"/g)).toHaveLength(3);
    expect(html).toContain('<span class="sr-only">Action</span>');
    expect(html).toContain("View as reviewer");
    expect(html).toContain('action="/review/impersonate"');
  });
});

afterEach(() => ctx.close());

async function load(personId = REVIEWER, url = "https://x.test/review") {
  return loader(loaderArgs(await signedInGet(url, personId)));
}

async function post(personId: string, fields: Record<string, string>, url = "https://x.test/review") {
  return action(actionArgs(await signedInPost(url, personId, fields)));
}

describe("reviewer workspace", () => {
  it("must fire: shows only assigned abstracts in currently open rounds and no organizer controls", async () => {
    const futureRound = "90000000-0000-4000-8000-000000000006";
    const closedRound = "90000000-0000-4000-8000-000000000007";
    await ctx.db.insert(reviewRounds).values([
      { id: futureRound, eventId: fixture.eventId, name: "Future", ordinal: 2, opensAt: new Date(Date.now() + 60_000) },
      { id: closedRound, eventId: fixture.eventId, name: "Closed", ordinal: 3, closesAt: new Date(Date.now() - 60_000) },
    ]);
    await ctx.db.insert(reviewAssignments).values([
      { id: "90000000-0000-4000-8000-000000000008", roundId: futureRound, sessionId: fixture.abstractIds[4], teamId: TEAM },
      { id: "90000000-0000-4000-8000-000000000009", roundId: closedRound, sessionId: fixture.abstractIds[5], teamId: TEAM },
    ]);

    const data = await load();
    expect(data.assignments.map((row) => row.sessionId)).toEqual([fixture.abstractIds[3]]);
    const html = renderToStaticMarkup(<ReviewerWorkspaceView loaderData={data} actionData={undefined} />);
    expect(html).toContain("Cost modelling for multi-agent systems");
    expect(html).not.toContain("Tool-calling failure modes, catalogued");
    expect(html).not.toContain("Why your guardrails are theatre");
    expect(html).not.toContain("Admin");
    expect(html).not.toContain("Settings");
    expect(html).not.toContain("Review ops");
    expect(html).toContain("Assigned abstracts only");
    expect(html).toContain("Not scored · 0 / 15");
  });

  it("announces failed score feedback to assistive technology", async () => {
    const data = await load();
    const html = renderToStaticMarkup(
      <ReviewerWorkspaceView
        loaderData={data}
        actionData={{ ok: false, error: "Programme fit must be between 1 and 5." }}
      />,
    );
    expect(html).toContain('role="alert"');
    expect(html).toContain("Programme fit must be between 1 and 5.");
  });

  it("must NOT fire: a signed-in person without event review-team membership gets 403", async () => {
    await expect(load(NON_MEMBER)).rejects.toMatchObject({ status: 403 });
  });

  it("must NOT fire: membership on another team reveals or scores none of this team's assignments", async () => {
    expect((await load(OUTSIDER)).assignments).toEqual([]);
    expect(await post(OUTSIDER, {
      intent: "save-review",
      roundId: OPEN_ROUND,
      sessionId: fixture.abstractIds[3],
      "score-fit": "5",
      "score-clarity": "5",
    })).toEqual({ ok: false, error: "That abstract is not assigned to you in an open round." });
    expect(await ctx.db.select().from(reviews)).toHaveLength(0);
  });

  it("renders the reviewer-team empty state without organizer navigation", async () => {
    await ctx.db.delete(reviewAssignments).where(eq(reviewAssignments.roundId, OPEN_ROUND));
    const data = await load();
    expect(data.assignments).toEqual([]);
    const html = renderToStaticMarkup(<ReviewerWorkspaceView loaderData={data} actionData={undefined} />);
    expect(html).toContain("No open assignments");
    expect(html).not.toContain("Review ops");
  });

  it("must fire: persists and reloads the current reviewer score and comment", async () => {
    const response = await post(REVIEWER, {
      intent: "save-review",
      roundId: OPEN_ROUND,
      sessionId: fixture.abstractIds[3],
      "score-fit": "5",
      "score-clarity": "4",
      comment: "Clear and directly useful.",
    });
    expect(response).toBeInstanceOf(Response);
    expect((response as Response).status).toBe(302);

    const saved = await ctx.db.query.reviews.findFirst({
      where: and(
        eq(reviews.roundId, OPEN_ROUND),
        eq(reviews.sessionId, fixture.abstractIds[3]),
        eq(reviews.reviewerId, REVIEWER),
      ),
    });
    expect(saved).toMatchObject({
      scores: { fit: 5, clarity: 4 },
      totalScore: 14,
      comment: "Clear and directly useful.",
    });
    const reloaded = await load();
    expect(reloaded.assignments[0].review).toMatchObject({ totalScore: 14, comment: "Clear and directly useful." });
  });

  it("must NOT fire: invalid scores, unassigned abstracts, and closed rounds write nothing", async () => {
    const closedRound = "90000000-0000-4000-8000-000000000010";
    await ctx.db.insert(reviewRounds).values({
      id: closedRound,
      eventId: fixture.eventId,
      name: "Closed",
      ordinal: 2,
      closesAt: new Date(Date.now() - 60_000),
    });
    await ctx.db.insert(reviewAssignments).values({
      id: "90000000-0000-4000-8000-000000000011",
      roundId: closedRound,
      sessionId: fixture.abstractIds[4],
      teamId: TEAM,
    });
    const valid = { "score-fit": "5", "score-clarity": "4" };
    expect(await post(REVIEWER, {
      intent: "save-review", roundId: OPEN_ROUND, sessionId: fixture.abstractIds[3],
      "score-fit": "8", "score-clarity": "4",
    })).toMatchObject({ ok: false });
    expect(await post(REVIEWER, {
      intent: "save-review", roundId: OPEN_ROUND, sessionId: fixture.abstractIds[4], ...valid,
    })).toEqual({ ok: false, error: "That abstract is not assigned to you in an open round." });
    expect(await post(REVIEWER, {
      intent: "save-review", roundId: closedRound, sessionId: fixture.abstractIds[4], ...valid,
    })).toEqual({ ok: false, error: "That abstract is not assigned to you in an open round." });
    expect(await ctx.db.select().from(reviews)).toHaveLength(0);
  });

  it("must NOT fire: round, team, and abstract from another event cannot be mixed into a write", async () => {
    const otherEvent = "90000000-0000-4000-8000-000000000012";
    const otherRound = "90000000-0000-4000-8000-000000000013";
    const otherTeam = "90000000-0000-4000-8000-000000000014";
    const otherAbstract = "90000000-0000-4000-8000-000000000015";
    await ctx.db.insert(events).values({ id: otherEvent, name: "Other event", slug: "other", timezone: "UTC" });
    await ctx.db.insert(reviewTeams).values({ id: otherTeam, eventId: otherEvent, name: "Other reviewers" });
    await ctx.db.insert(reviewTeamMembers).values({ teamId: otherTeam, personId: REVIEWER });
    await ctx.db.insert(reviewRounds).values({ id: otherRound, eventId: otherEvent, name: "Other round", ordinal: 1 });
    await ctx.db.insert(sessions).values({ id: otherAbstract, eventId: otherEvent, isAbstract: true, title: "Secret other event abstract", status: "pending" });
    await ctx.db.insert(reviewAssignments).values({ id: "90000000-0000-4000-8000-000000000016", roundId: otherRound, sessionId: otherAbstract, teamId: otherTeam });

    expect(await post(REVIEWER, {
      intent: "save-review", roundId: otherRound, sessionId: otherAbstract,
      "score-relevance": "5", "score-depth": "5", "score-speaker": "5",
    })).toEqual({ ok: false, error: "That abstract is not assigned to you in an open round." });
    expect((await load()).assignments.some((row) => row.sessionId === otherAbstract)).toBe(false);
    const otherWorkspace = await load(REVIEWER, "https://x.test/review?event=other");
    expect(otherWorkspace.assignments.map((row) => row.sessionId)).toEqual([otherAbstract]);
    expect(otherWorkspace.assignments.some((row) => row.sessionId === fixture.abstractIds[3])).toBe(false);
    expect(await ctx.db.select().from(reviews)).toHaveLength(0);
  });
});
