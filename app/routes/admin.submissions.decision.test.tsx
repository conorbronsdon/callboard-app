/** Route-level proof that a commit reports decision sends to the organizer. */
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { commLog } from "~/db/schema";
import { templateKeyOf } from "~/lib/comms/comm-log.server";
import { signedInGet, signedInPost } from "~/test/auth";
import { installTestDb, type TestDbContext } from "~/test/db";
import { seedDemoFixture, type DemoFixture } from "~/test/fixtures";

import { AbstractsView, action, loader } from "./admin.submissions";

type ActionArgs = Parameters<typeof action>[0];
type LoaderArgs = Parameters<typeof loader>[0];

let ctx: TestDbContext;
let fixture: DemoFixture;

beforeEach(async () => {
  ctx = installTestDb({ MAIL_DRIVER: "console" });
  fixture = await seedDemoFixture(ctx.db);
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  ctx.close();
});

describe("decision commit confirmation", () => {
  it("carries the notified count through the redirect and confirmation copy", async () => {
    const request = await signedInPost(
      "https://review.callboard.test/admin/submissions",
      fixture.adminId,
      { intent: "commit-queues", tab: "accept_queue" },
    );
    const response = await action({ request, params: {}, context: {} } as unknown as ActionArgs);
    expect(response).toBeInstanceOf(Response);
    const location = (response as Response).headers.get("location")!;
    expect(location).toContain("ca=1");
    expect(location).toContain("cd=1");
    expect(location).toContain("cn=2");

    const logged = (await ctx.db.select().from(commLog)).filter((row) =>
      ["decision_accept", "decision_decline"].includes(templateKeyOf(row.meta) ?? ""),
    );
    expect(logged).toHaveLength(2);

    const loaderData = await loader({
      request: await signedInGet(new URL(location, request.url).toString(), fixture.adminId),
      params: {},
      context: {},
    } as unknown as LoaderArgs);
    expect(loaderData.notice).toBe(
      "Queues committed — 1 accepted, 1 declined, 2 speakers notified.",
    );
    expect(renderToStaticMarkup(<AbstractsView {...loaderData} />)).toContain(
      "2 speakers notified",
    );
  });
});
