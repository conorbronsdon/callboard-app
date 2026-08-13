import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { reviewTeamMembers, reviewTeams } from "~/db/schema";
import { signedInGet } from "~/test/auth";
import { installTestDb, type TestDbContext } from "~/test/db";
import { seedDemoFixture, type DemoFixture } from "~/test/fixtures";

import { loader } from "./auth.login";

type LoaderArgs = Parameters<typeof loader>[0];
const args = (request: Request) => ({ request, params: {}, context: {} }) as unknown as LoaderArgs;

let ctx: TestDbContext;
let fixture: DemoFixture;

beforeEach(async () => {
  ctx = installTestDb();
  fixture = await seedDemoFixture(ctx.db);
});

afterEach(() => ctx.close());

async function landing(personId: string): Promise<Response> {
  try {
    await loader(args(await signedInGet("https://x.test/login", personId)));
  } catch (error) {
    if (error instanceof Response) return error;
    throw error;
  }
  throw new Error("Expected an authenticated landing redirect.");
}

describe("authenticated landing selection", () => {
  it("must fire: a non-admin review-team member lands in the reviewer workspace", async () => {
    const teamId = "92000000-0000-4000-8000-000000000001";
    await ctx.db.insert(reviewTeams).values({ id: teamId, eventId: fixture.eventId, name: "Reviewers" });
    await ctx.db.insert(reviewTeamMembers).values({ teamId, personId: fixture.speakerIds[0] });
    expect((await landing(fixture.speakerIds[0])).headers.get("location")).toBe("/review");
  });

  it("must NOT fire: ordinary speakers and admins keep their existing landing pages", async () => {
    expect((await landing(fixture.speakerIds[0])).headers.get("location")).toBe("/portal");
    expect((await landing(fixture.adminId)).headers.get("location")).toBe("/admin");
  });
});
