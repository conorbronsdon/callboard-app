import { renderToStaticMarkup } from "react-dom/server";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  reviewAssignments,
  reviewRounds,
  reviewTeamMembers,
  reviewTeams,
} from "~/db/schema";
import { listComms } from "~/lib/comms/comm-log.server";
import { signedInGet, signedInPost } from "~/test/auth";
import { installTestDb, type TestDbContext } from "~/test/db";
import { seedDemoFixture, type DemoFixture } from "~/test/fixtures";

import { ReviewOperationsView, action, loader } from "./admin.reviews";

type LoaderArgs = Parameters<typeof loader>[0];
type ActionArgs = Parameters<typeof action>[0];
const BASE = "https://x.test/admin/reviews";
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

describe("review reminder route action", () => {
  it("must send, log, redirect with the count, and render confirmation", async () => {
    const roundId = "route-reminder-round-0000-4000-8000-000000000001";
    const teamId = "route-reminder-team-0000-4000-8000-000000000001";
    await ctx.db.insert(reviewRounds).values({
      id: roundId,
      eventId: fixture.eventId,
      name: "Route reminder round",
      ordinal: 1,
    });
    await ctx.db.insert(reviewTeams).values({
      id: teamId,
      eventId: fixture.eventId,
      name: "Route reminder team",
    });
    await ctx.db.insert(reviewTeamMembers).values({
      teamId,
      personId: fixture.adminId,
    });
    await ctx.db.insert(reviewAssignments).values({
      id: "route-reminder-assignment-0000-4000-8000-000000000001",
      roundId,
      teamId,
      sessionId: fixture.abstractIds[3],
    });

    const response = (await action(
      asActionArgs(
        await signedInPost(BASE, fixture.adminId, {
          intent: "remind-reviewers",
          roundId,
        }),
      ),
    )) as Response;
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(
      "/admin/reviews?reminded=1&reminderFailed=0",
    );

    const rows = await listComms({ eventId: fixture.eventId, db: ctx.db });
    expect(rows.filter((row) => row.templateKey === "review_reminder")).toHaveLength(1);

    const landing = await loader(
      asLoaderArgs(
        await signedInGet(
          `https://x.test${response.headers.get("location")}`,
          fixture.adminId,
        ),
      ),
    );
    expect(landing.notice).toBe("Reminded 1 reviewer with outstanding reviews.");
    const markup = renderToStaticMarkup(<ReviewOperationsView {...landing} />);
    expect(markup).toContain("Reminded 1 reviewer with outstanding reviews.");
    expect(markup).toContain("Remind reviewers");
  });

  it("must not accept a round from another event", async () => {
    const result = await action(
      asActionArgs(
        await signedInPost(BASE, fixture.adminId, {
          intent: "remind-reviewers",
          roundId: "missing-round",
        }),
      ),
    );
    expect(result).toMatchObject({ ok: false });
    expect(
      await ctx.db
        .select()
        .from(reviewAssignments)
        .where(eq(reviewAssignments.roundId, "missing-round")),
    ).toHaveLength(0);
  });
});
