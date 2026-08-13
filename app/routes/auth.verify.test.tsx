/**
 * Pins magic-link destinations when reviewer authority and requested paths disagree.
 * Teamless reviewer invites must not create a successful login that redirects to a 403.
 * Verification-time gating is the seam because both URL and stored redirects converge here.
 */
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  authTokens,
  eventPeople,
  people,
  reviewTeamMembers,
  reviewTeams,
} from "~/db/schema";
import { issueMagicLink } from "~/lib/auth/auth.server";
import { installTestDb, type TestDbContext } from "~/test/db";
import { seedDemoFixture, type DemoFixture } from "~/test/fixtures";

import { loader } from "./auth.verify";

type LoaderArgs = Parameters<typeof loader>[0];
const args = (request: Request) => ({ request, params: {}, context: {} }) as unknown as LoaderArgs;

const TEAM_ID = "93000000-0000-4000-8000-000000000001";
const SPEAKER_EMAIL = "speaker@callboard.dev";

let ctx: TestDbContext;
let fixture: DemoFixture;

beforeEach(async () => {
  ctx = installTestDb();
  fixture = await seedDemoFixture(ctx.db);
});

afterEach(() => ctx.close());

async function verify(url: string): Promise<Response> {
  try {
    await loader(args(new Request(url)));
  } catch (error) {
    if (error instanceof Response) return error;
    throw error;
  }
  throw new Error("Expected magic-link verification to redirect.");
}

async function mintFor(redirectTo: string, email = SPEAKER_EMAIL) {
  return issueMagicLink({
    request: new Request("https://x.test/admin/reviews"),
    email,
    redirectTo,
  });
}

async function makeTeamless(): Promise<void> {
  await ctx.db
    .update(eventPeople)
    .set({ isReviewer: true })
    .where(
      and(
        eq(eventPeople.eventId, fixture.eventId),
        eq(eventPeople.personId, fixture.speakerIds[0]),
      ),
    );
}

async function makeTeamMember(): Promise<void> {
  await makeTeamless();
  await ctx.db
    .insert(reviewTeams)
    .values({ id: TEAM_ID, eventId: fixture.eventId, name: "Reviewers" });
  await ctx.db
    .insert(reviewTeamMembers)
    .values({ teamId: TEAM_ID, personId: fixture.speakerIds[0] });
}

describe("magic-link verification destination", () => {
  it("must fire: a teamless reviewer invite falls back to the portal", async () => {
    await makeTeamless();
    const issued = await mintFor("/review");

    expect(new URL(issued.url).searchParams.get("redirectTo")).toBe("/review");
    const stored = await ctx.db.query.authTokens.findFirst({
      where: eq(authTokens.personId, fixture.speakerIds[0]),
    });
    expect(stored?.redirectTo).toBe("/review");

    const response = await verify(issued.url);
    expect(response.headers.get("location")).toBe("/portal");
    expect(response.headers.get("location")).not.toBe("/review");
    expect(response.headers.get("Set-Cookie")).toBeTruthy();
  });

  it("must fire: a stored review redirect without a URL redirect falls back to the portal", async () => {
    await makeTeamless();
    const issued = await mintFor("/review");
    const staleUrl = new URL(issued.url);
    staleUrl.searchParams.delete("redirectTo");

    expect((await verify(staleUrl.toString())).headers.get("location")).toBe("/portal");
  });

  it("must fire: review sub-path and query-string redirects are gated for teamless people", async () => {
    await makeTeamless();

    for (const redirectTo of ["/review/round/1", "/review?event=demo-conf"]) {
      const issued = await mintFor(redirectTo);
      expect((await verify(issued.url)).headers.get("location")).toBe("/portal");
    }
  });

  it("must STILL fire: genuine reviewers retain review root and sub-path redirects", async () => {
    await makeTeamMember();

    for (const redirectTo of ["/review", "/review/round/1"]) {
      const issued = await mintFor(redirectTo);
      expect((await verify(issued.url)).headers.get("location")).toBe(redirectTo);
    }
  });

  it("must NOT fire: non-review destinations remain unchanged for teamless people", async () => {
    await makeTeamless();

    for (const redirectTo of ["/submit/demo-conf/main/step/submission", "/portal/tasks"]) {
      const issued = await mintFor(redirectTo);
      expect((await verify(issued.url)).headers.get("location")).toBe(redirectTo);
    }
  });

  it("must NOT fire: review-like sibling segments remain unchanged for teamless people", async () => {
    await makeTeamless();

    for (const redirectTo of ["/reviewer-onboarding", "/reviews"]) {
      const issued = await mintFor(redirectTo);
      expect((await verify(issued.url)).headers.get("location")).toBe(redirectTo);
    }
  });

  it("must NOT fire: admins use their default for review but retain admin redirects", async () => {
    const admin = await ctx.db.query.people.findFirst({
      columns: { email: true },
      where: eq(people.id, fixture.adminId),
    });
    if (!admin) throw new Error("Expected the fixture admin to exist.");

    const reviewLink = await mintFor("/review", admin.email);
    expect((await verify(reviewLink.url)).headers.get("location")).toBe("/admin");

    const adminLink = await mintFor("/admin/reviews", admin.email);
    expect((await verify(adminLink.url)).headers.get("location")).toBe("/admin/reviews");
  });

  it("must NOT fire: missing and invalid tokens keep returning loader data", async () => {
    expect(await loader(args(new Request("https://x.test/auth/verify")))).toEqual({
      reason: "missing",
    });
    expect(
      await loader(args(new Request("https://x.test/auth/verify?token=garbage"))),
    ).toEqual({ reason: "invalid" });
  });
});
