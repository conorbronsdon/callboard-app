import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { people, reviewTeamMembers, reviewTeams } from "~/db/schema";
import { signedInPost } from "~/test/auth";
import { installTestDb, type TestDbContext } from "~/test/db";
import { seedDemoFixture, type DemoFixture } from "~/test/fixtures";

import { action } from "./review.impersonate";

type ActionArgs = Parameters<typeof action>[0];
const args = (request: Request) => ({ request, params: {}, context: {} }) as unknown as ActionArgs;

const REVIEWER = "91000000-0000-4000-8000-000000000001";
const OUTSIDER = "91000000-0000-4000-8000-000000000002";
const TEAM = "91000000-0000-4000-8000-000000000003";

let ctx: TestDbContext;
let fixture: DemoFixture;

beforeEach(async () => {
  ctx = installTestDb();
  fixture = await seedDemoFixture(ctx.db);
  await ctx.db.insert(people).values([
    { id: REVIEWER, email: "reviewer@example.com", role: "speaker" },
    { id: OUTSIDER, email: "outsider@example.com", role: "speaker" },
  ]);
  await ctx.db.insert(reviewTeams).values({ id: TEAM, eventId: fixture.eventId, name: "Reviewers" });
  await ctx.db.insert(reviewTeamMembers).values({ teamId: TEAM, personId: REVIEWER });
});

afterEach(() => ctx.close());

async function impersonate(actorId: string, targetId: string) {
  const request = await signedInPost("https://x.test/review/impersonate", actorId, { personId: targetId });
  return action(args(request));
}

describe("organizer reviewer preview", () => {
  it("must fire: an admin can mint the existing signed view-as cookie only for an event reviewer", async () => {
    const response = await impersonate(fixture.adminId, REVIEWER);
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toContain("/review?event=");
    expect(response.headers.get("set-cookie")).toMatch(/^cb_review_as=/);
  });

  it("must NOT fire: non-reviewer targets and non-admin callers cannot mint preview authority", async () => {
    await expect(impersonate(fixture.adminId, OUTSIDER)).rejects.toMatchObject({ status: 404 });
    await expect(impersonate(REVIEWER, REVIEWER)).rejects.toMatchObject({ status: 403 });
  });
});
