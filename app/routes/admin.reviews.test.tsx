import { renderToStaticMarkup } from "react-dom/server";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  events,
  reviewAssignments,
  reviewRounds,
  reviews,
  reviewTeamMembers,
  reviewTeams,
  sessions,
} from "~/db/schema";
import { createLoginSession } from "~/lib/auth/auth.server";
import { signedInGet } from "~/test/auth";
import { installTestDb, type TestDbContext } from "~/test/db";
import { seedDemoFixture, type DemoFixture } from "~/test/fixtures";

import { ReviewOperationsView, action, loader } from "./admin.reviews";

type LoaderArgs = Parameters<typeof loader>[0];
type ActionArgs = Parameters<typeof action>[0];

const asLoaderArgs = (request: Request) =>
  ({ request, params: {}, context: {} }) as unknown as LoaderArgs;
const asActionArgs = (request: Request) =>
  ({ request, params: {}, context: {} }) as unknown as ActionArgs;

let ctx: TestDbContext;
let fixture: DemoFixture;

beforeEach(async () => {
  ctx = installTestDb();
  fixture = await seedDemoFixture(ctx.db);
});
afterEach(() => ctx.close());

async function load() {
  const request = await signedInGet("https://x.test/admin/reviews", fixture.adminId);
  return loader(asLoaderArgs(request));
}

async function post(entries: [string, string][]) {
  const url = "https://x.test/admin/reviews";
  const cookie = (await createLoginSession(new Request(url), fixture.adminId)).split(";")[0];
  const body = new URLSearchParams();
  for (const [key, value] of entries) body.append(key, value);
  return action(
    asActionArgs(
      new Request(url, {
        method: "POST",
        headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
        body: body.toString(),
      }),
    ),
  );
}

async function createTeam(name = "Programme committee") {
  await post([
    ["intent", "create-team"],
    ["name", name],
  ]);
  return ctx.db.query.reviewTeams.findFirst({
    where: and(eq(reviewTeams.eventId, fixture.eventId), eq(reviewTeams.name, name)),
  });
}

async function createRound(name = "Round 1") {
  await post([
    ["intent", "create-round"],
    ["name", name],
  ]);
  return ctx.db.query.reviewRounds.findFirst({
    where: and(eq(reviewRounds.eventId, fixture.eventId), eq(reviewRounds.name, name)),
  });
}

describe("review operations", () => {
  it("creates and renames an event-scoped team", async () => {
    const team = await createTeam();
    expect(team).toBeDefined();

    await post([
      ["intent", "rename-team"],
      ["teamId", team!.id],
      ["name", "Workshop committee"],
    ]);
    expect(
      await ctx.db.query.reviewTeams.findFirst({ where: eq(reviewTeams.id, team!.id) }),
    ).toMatchObject({ name: "Workshop committee", eventId: fixture.eventId });
  });

  it("adds and removes only an admin attached to this event", async () => {
    const team = await createTeam();
    await post([
      ["intent", "add-member"],
      ["teamId", team!.id],
      ["personId", fixture.adminId],
    ]);
    expect(await ctx.db.select().from(reviewTeamMembers)).toHaveLength(1);

    await post([
      ["intent", "remove-member"],
      ["teamId", team!.id],
      ["personId", fixture.adminId],
    ]);
    expect(await ctx.db.select().from(reviewTeamMembers)).toHaveLength(0);

    const rejected = await post([
      ["intent", "add-member"],
      ["teamId", team!.id],
      ["personId", fixture.speakerIds[0]],
    ]);
    expect(rejected).toMatchObject({ ok: false });
  });

  it("safely edits a rubric and locks it after a submitted review", async () => {
    const round = await createRound();
    const edited = await post([
      ["intent", "save-rubric"],
      ["roundId", round!.id],
      ["criterionKey", "fit"],
      ["criterionLabel", "Programme fit"],
      ["criterionMin", "1"],
      ["criterionMax", "10"],
      ["criterionWeight", "3"],
      ["criterionKey", "depth"],
      ["criterionLabel", "Technical depth"],
      ["criterionMin", "1"],
      ["criterionMax", "5"],
      ["criterionWeight", "2"],
    ]);
    expect((edited as Response).status).toBe(302);

    let saved = await ctx.db.query.reviewRounds.findFirst({ where: eq(reviewRounds.id, round!.id) });
    expect(saved?.rubric).toEqual({
      criteria: [
        { key: "fit", label: "Programme fit", min: 1, max: 10, weight: 3 },
        { key: "depth", label: "Technical depth", min: 1, max: 5, weight: 2 },
      ],
    });

    await ctx.db.insert(reviews).values({
      roundId: round!.id,
      sessionId: fixture.abstractIds[3],
      reviewerId: fixture.adminId,
      scores: { fit: 8, depth: 4 },
      totalScore: 32,
      submittedAt: new Date(),
    });
    const locked = await post([
      ["intent", "save-rubric"],
      ["roundId", round!.id],
      ["criterionKey", "different"],
      ["criterionLabel", "Different"],
      ["criterionMin", "1"],
      ["criterionMax", "5"],
      ["criterionWeight", "1"],
    ]);
    expect(locked).toEqual({
      ok: false,
      error: "A rubric cannot change after a reviewer has submitted a score.",
    });
    saved = await ctx.db.query.reviewRounds.findFirst({ where: eq(reviewRounds.id, round!.id) });
    expect((saved?.rubric as { criteria: { key: string }[] }).criteria[0].key).toBe("fit");
  });

  it("must fire: saves a dropdown criterion from aligned editor rows", async () => {
    const round = await createRound();
    const response = await post([
      ["intent", "save-rubric"],
      ["roundId", round!.id],
      ["criterionType", "number"],
      ["criterionKey", "fit"],
      ["criterionLabel", "Programme fit"],
      ["criterionMin", "1"],
      ["criterionMax", "5"],
      ["criterionWeight", "2"],
      ["criterionOptions", ""],
      ["criterionRemove", ""],
      ["criterionType", "select"],
      ["criterionKey", "recommendation"],
      ["criterionLabel", "Recommendation"],
      ["criterionMin", "0"],
      ["criterionMax", "0"],
      ["criterionWeight", "0"],
      ["criterionOptions", "Accept\nMaybe, Reject"],
      ["criterionRemove", ""],
    ]);

    expect((response as Response).status).toBe(302);
    const saved = await ctx.db.query.reviewRounds.findFirst({
      where: eq(reviewRounds.id, round!.id),
    });
    expect(saved?.rubric).toEqual({
      criteria: [
        { key: "fit", label: "Programme fit", min: 1, max: 5, weight: 2 },
        {
          key: "recommendation",
          label: "Recommendation",
          min: 0,
          max: 0,
          weight: 0,
          type: "select",
          options: ["Accept", "Maybe", "Reject"],
        },
      ],
    });
  });

  it("must fire: renders and round-trips a free-text criterion", async () => {
    const round = await createRound();
    const before = renderToStaticMarkup(<ReviewOperationsView {...(await load())} />);
    expect(before).toContain('<option value="text">Free text</option>');

    const response = await post([
      ["intent", "save-rubric"],
      ["roundId", round!.id],
      ["criterionType", "number"],
      ["criterionKey", "fit"],
      ["criterionLabel", "Programme fit"],
      ["criterionMin", "1"],
      ["criterionMax", "5"],
      ["criterionWeight", "2"],
      ["criterionOptions", ""],
      ["criterionRemove", ""],
      ["criterionType", "text"],
      ["criterionKey", "reviewer_note"],
      ["criterionLabel", "Reviewer note"],
      ["criterionMin", "abc"],
      ["criterionMax", "-50"],
      ["criterionWeight", "999"],
      ["criterionOptions", "ignored option text"],
      ["criterionRemove", ""],
    ]);

    expect((response as Response).status).toBe(302);
    const reloaded = await load();
    expect(reloaded.rounds[0].rubric.criteria).toEqual([
      { key: "fit", label: "Programme fit", min: 1, max: 5, weight: 2 },
      {
        key: "reviewer_note",
        label: "Reviewer note",
        min: 0,
        max: 0,
        weight: 0,
        type: "text",
      },
    ]);
    const after = renderToStaticMarkup(<ReviewOperationsView {...reloaded} />);
    expect(after).toContain('<option value="text" selected="">Free text</option>');
    expect(after).toContain("Minimum, maximum, weight, and options are ignored for free-text criteria.");
  });

  it("must NOT fire: rejects one dropdown option without changing the stored rubric", async () => {
    const round = await createRound();
    const before = round!.rubric;
    const response = await post([
      ["intent", "save-rubric"],
      ["roundId", round!.id],
      ["criterionType", "select"],
      ["criterionKey", "recommendation"],
      ["criterionLabel", "Recommendation"],
      ["criterionMin", "0"],
      ["criterionMax", "0"],
      ["criterionWeight", "0"],
      ["criterionOptions", "Accept"],
      ["criterionRemove", ""],
    ]);

    expect(response).toMatchObject({ ok: false });
    const saved = await ctx.db.query.reviewRounds.findFirst({
      where: eq(reviewRounds.id, round!.id),
    });
    expect(saved?.rubric).toEqual(before);
  });

  it("batch assigns selected event abstracts and removes an assignment", async () => {
    const team = await createTeam();
    const round = await createRound();

    const result = await post([
      ["intent", "assign-team"],
      ["roundId", round!.id],
      ["teamId", team!.id],
      ["sessionId", fixture.abstractIds[3]],
      ["sessionId", fixture.abstractIds[4]],
    ]);
    expect((result as Response).status).toBe(302);

    const assigned = await ctx.db
      .select()
      .from(reviewAssignments)
      .where(eq(reviewAssignments.roundId, round!.id));
    expect(assigned.map((row) => row.sessionId).sort()).toEqual(
      [fixture.abstractIds[3], fixture.abstractIds[4]].sort(),
    );

    await post([
      ["intent", "unassign-team"],
      ["assignmentId", assigned[0].id],
    ]);
    expect(await ctx.db.select().from(reviewAssignments)).toHaveLength(1);
  });

  it("must NOT fire: rejects cross-event teams, rounds, submissions, and assignments", async () => {
    const team = await createTeam();
    const round = await createRound();
    const otherEvent = "99999999-9999-4999-8999-999999999999";
    await ctx.db.insert(events).values({
      id: otherEvent,
      name: "Other event",
      slug: "other-event",
      timezone: "UTC",
    });
    const otherRound = "88888888-8888-4888-8888-888888888888";
    const otherTeam = "77777777-7777-4777-8777-777777777777";
    const otherSession = "66666666-6666-4666-8666-666666666666";
    await ctx.db.insert(reviewRounds).values({
      id: otherRound,
      eventId: otherEvent,
      name: "Other round",
      ordinal: 1,
    });
    await ctx.db.insert(reviewTeams).values({ id: otherTeam, eventId: otherEvent, name: "Other team" });
    await ctx.db.insert(sessions).values({
      id: otherSession,
      eventId: otherEvent,
      title: "Other abstract",
      status: "pending",
      isAbstract: true,
    });

    for (const entries of [
      [["intent", "add-member"], ["teamId", otherTeam], ["personId", fixture.adminId]],
      [["intent", "save-rubric"], ["roundId", otherRound]],
      [["intent", "assign-team"], ["roundId", round!.id], ["teamId", team!.id], ["sessionId", otherSession]],
    ] as [string, string][][]) {
      expect(await post(entries)).toMatchObject({ ok: false });
    }

    const otherAssignment = "55555555-5555-4555-8555-555555555555";
    await ctx.db.insert(reviewAssignments).values({
      id: otherAssignment,
      roundId: otherRound,
      teamId: otherTeam,
      sessionId: otherSession,
    });
    expect(
      await post([["intent", "unassign-team"], ["assignmentId", otherAssignment]]),
    ).toMatchObject({ ok: false });
    expect(
      await ctx.db.query.reviewAssignments.findFirst({
        where: eq(reviewAssignments.id, otherAssignment),
      }),
    ).toBeDefined();
  });

  it("renders useful empty and configured states", async () => {
    let data = await load();
    let html = renderToStaticMarkup(<ReviewOperationsView {...data} />);
    expect(html).toContain("Review operations");
    expect(html).toContain("No reviewer teams yet.");
    expect(html).toContain("No review rounds yet.");

    const team = await createTeam();
    const round = await createRound();
    await post([
      ["intent", "add-member"],
      ["teamId", team!.id],
      ["personId", fixture.adminId],
    ]);
    data = await load();
    html = renderToStaticMarkup(<ReviewOperationsView {...data} />);
    expect(html).toContain("Programme committee");
    expect(html).toContain("Ada Organiser");
    expect(html).toContain("Round 1");
    expect(html).toContain("Assign selected");
    expect(html).toContain("Save rubric");
    expect(data.rounds[0].id).toBe(round!.id);
  });

  it("must fire: reports selected-event reviewer completion and unstaffed assignments", async () => {
    const team = await createTeam();
    const emptyTeam = await createTeam("No members");
    const round = await createRound();
    await post([
      ["intent", "add-member"],
      ["teamId", team!.id],
      ["personId", fixture.adminId],
    ]);
    await ctx.db.insert(reviewAssignments).values([
      {
        id: "10000000-0000-4000-8000-000000000001",
        roundId: round!.id,
        teamId: team!.id,
        sessionId: fixture.abstractIds[3],
      },
      {
        id: "10000000-0000-4000-8000-000000000002",
        roundId: round!.id,
        teamId: team!.id,
        sessionId: fixture.abstractIds[4],
      },
      {
        id: "10000000-0000-4000-8000-000000000003",
        roundId: round!.id,
        teamId: emptyTeam!.id,
        sessionId: fixture.abstractIds[5],
      },
    ]);
    await ctx.db.insert(reviews).values({
      roundId: round!.id,
      sessionId: fixture.abstractIds[3],
      reviewerId: fixture.adminId,
      submittedAt: new Date(),
    });

    const data = await load();
    expect(data.rounds[0].progress).toMatchObject({
      expectedReviews: 2,
      completedReviews: 1,
      remainingReviews: 1,
      reviewerCount: 1,
      unstaffedAssignments: 1,
    });
    const html = renderToStaticMarkup(<ReviewOperationsView {...data} />);
    expect(html).toContain("Reviewer progress");
    expect(html).toContain("Reviews complete");
    expect(html).toContain("1 / 2");
    expect(html).toContain("1 left");
    expect(html).toContain("1 team assignment has no reviewers.");
  });

  it("must not fire: excludes reviewer progress from another event", async () => {
    const currentRound = await createRound("Current round");
    const currentTeam = await createTeam("Current team");
    await post([
      ["intent", "add-member"],
      ["teamId", currentTeam!.id],
      ["personId", fixture.adminId],
    ]);
    const otherEventId = "20000000-0000-4000-8000-000000000001";
    const otherTeamId = "20000000-0000-4000-8000-000000000002";
    const otherRoundId = "20000000-0000-4000-8000-000000000003";
    const otherSessionId = "20000000-0000-4000-8000-000000000004";
    await ctx.db.insert(events).values({
      id: otherEventId,
      name: "Other event",
      slug: "other-progress-event",
      timezone: "UTC",
    });
    await ctx.db.insert(reviewTeams).values({ id: otherTeamId, eventId: otherEventId, name: "Other team" });
    await ctx.db.insert(reviewTeamMembers).values({ teamId: otherTeamId, personId: fixture.adminId });
    await ctx.db.insert(reviewRounds).values({
      id: otherRoundId,
      eventId: otherEventId,
      name: "Other round",
      ordinal: 1,
    });
    await ctx.db.insert(sessions).values({
      id: otherSessionId,
      eventId: otherEventId,
      title: "Other abstract",
      status: "pending",
      isAbstract: true,
    });
    await ctx.db.insert(reviewAssignments).values({
      id: "20000000-0000-4000-8000-000000000005",
      roundId: otherRoundId,
      teamId: otherTeamId,
      sessionId: otherSessionId,
    });
    await ctx.db.insert(reviews).values({
      roundId: otherRoundId,
      sessionId: otherSessionId,
      reviewerId: fixture.adminId,
      submittedAt: new Date(),
    });
    await ctx.db.insert(reviews).values({
      id: "20000000-0000-4000-8000-000000000006",
      roundId: currentRound!.id,
      sessionId: otherSessionId,
      reviewerId: fixture.adminId,
      submittedAt: new Date(),
    });
    const deletedSessionId = "20000000-0000-4000-8000-000000000007";
    await ctx.db.insert(sessions).values({
      id: deletedSessionId,
      eventId: fixture.eventId,
      title: "Deleted abstract",
      status: "pending",
      isAbstract: true,
      deletedAt: new Date(),
    });
    await ctx.db.insert(reviewAssignments).values({
      id: "20000000-0000-4000-8000-000000000008",
      roundId: currentRound!.id,
      teamId: currentTeam!.id,
      sessionId: deletedSessionId,
    });
    await ctx.db.insert(reviews).values({
      id: "20000000-0000-4000-8000-000000000009",
      roundId: currentRound!.id,
      sessionId: deletedSessionId,
      reviewerId: fixture.adminId,
      submittedAt: new Date(),
    });

    const data = await load();
    expect(data.rounds).toHaveLength(1);
    expect(data.rounds[0]).toMatchObject({
      id: currentRound!.id,
      submittedReviews: 0,
      progress: { expectedReviews: 0, completedReviews: 0 },
    });
    expect(data.assignments).toHaveLength(0);
    const html = renderToStaticMarkup(<ReviewOperationsView {...data} />);
    expect(html).not.toContain("Other round");
    expect(html).not.toContain("Other abstract");
    expect(html).not.toContain("Deleted abstract");
  });
});
