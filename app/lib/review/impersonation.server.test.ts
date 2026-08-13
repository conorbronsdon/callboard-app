import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createLoginSession } from "~/lib/auth/auth.server";
import {
  requirePortalActor,
  startImpersonationCookie,
} from "~/lib/portal/impersonation.server";
import { installTestDb, type TestDbContext } from "~/test/db";
import { seedDemoFixture, type DemoFixture } from "~/test/fixtures";

import { requireReviewerActor } from "./access.server";
import {
  startReviewerImpersonationCookie,
  stopReviewerImpersonationCookie,
} from "./impersonation.server";

let ctx: TestDbContext;
let fixture: DemoFixture;

beforeEach(async () => {
  ctx = installTestDb();
  fixture = await seedDemoFixture(ctx.db);
});

afterEach(() => ctx.close());

function cookieValue(setCookie: string): string {
  return setCookie.split(";")[0];
}

async function adminRequest(extraCookie: string): Promise<Request> {
  const url = "https://x.test/review";
  const session = await createLoginSession(new Request(url), fixture.adminId);
  return new Request(url, {
    headers: { cookie: `${cookieValue(session)}; ${cookieValue(extraCookie)}` },
  });
}

describe("reviewer preview cookie isolation", () => {
  it("must fire: the reviewer cookie changes only the reviewer actor", async () => {
    const cookie = await startReviewerImpersonationCookie(
      new Request("https://x.test/review"),
      fixture.adminId,
      fixture.speakerIds[1],
    );
    const request = await adminRequest(cookie);

    const reviewer = await requireReviewerActor(request);
    expect(reviewer.person.id).toBe(fixture.speakerIds[1]);
    expect(reviewer.impersonatedBy?.id).toBe(fixture.adminId);

    const portal = await requirePortalActor(request);
    expect(portal.person.id).toBe(fixture.adminId);
    expect(portal.impersonatedBy).toBeNull();
  });

  it("must NOT fire: the speaker portal cookie never changes the reviewer actor", async () => {
    const cookie = await startImpersonationCookie(
      new Request("https://x.test/portal"),
      fixture.adminId,
      fixture.speakerIds[1],
      fixture.eventId,
    );
    const request = await adminRequest(cookie);

    const portal = await requirePortalActor(request);
    expect(portal.person.id).toBe(fixture.speakerIds[1]);
    expect(portal.impersonatedBy?.id).toBe(fixture.adminId);

    const reviewer = await requireReviewerActor(request);
    expect(reviewer.person.id).toBe(fixture.adminId);
    expect(reviewer.impersonatedBy).toBeNull();
  });

  it("clears only the reviewer preview cookie", () => {
    const cleared = stopReviewerImpersonationCookie(new Request("https://x.test/review"));
    expect(cleared).toMatch(/^cb_review_as=/);
    expect(cleared).toContain("Max-Age=0");
    expect(cleared).not.toContain("cb_view_as");
  });
});
