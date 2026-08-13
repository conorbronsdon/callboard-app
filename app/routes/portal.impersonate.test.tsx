/**
 * `POST /portal/impersonate` — does the organizer's EVENT selection survive?
 *
 * The reviewer sibling carries the selection in the redirect
 * (`review.impersonate.tsx:31`) because `/review` is one flat route. The portal
 * is a five-tab layout, so a `?event=` on the landing URL is dropped by the
 * first tab click — a redirect-only fix would pass a landing-page assertion and
 * still ship the bug. Every case below therefore asserts through a SECOND,
 * BARE request (`/portal/tasks`, no query string), which is what a tab click
 * actually sends.
 *
 * Each must-fire sits beside the must-not-fire a naive implementation would
 * break: an impersonation that pinned the portal to the last-used event
 * regardless of who is looking would pass the first test and fail the controls.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createLoginSession } from "~/lib/auth/auth.server";
import { readImpersonationCookie } from "~/lib/portal/impersonation.server";
import { loadSubmissions, portalContext } from "~/lib/portal/portal.server";
import { signedInPost } from "~/test/auth";
import { installTestDb, type TestDbContext } from "~/test/db";
import {
  seedDemoFixture,
  seedOtherEvent,
  type DemoFixture,
  type OtherEventFixture,
} from "~/test/fixtures";

import { action } from "./portal.impersonate";

type ActionArgs = Parameters<typeof action>[0];
const args = (request: Request) => ({ request, params: {}, context: {} }) as unknown as ActionArgs;

let ctx: TestDbContext;
let fixture: DemoFixture;
let other: OtherEventFixture;

beforeEach(async () => {
  ctx = installTestDb();
  fixture = await seedDemoFixture(ctx.db);
  other = await seedOtherEvent(ctx.db);
});
afterEach(() => ctx.close());

/** Start impersonating. `query` is what the admin's form action carries. */
async function startViewAs(adminId: string, targetId: string, query = ""): Promise<Response> {
  const request = await signedInPost(
    `https://x.test/portal/impersonate${query}`,
    adminId,
    { personId: targetId },
  );
  return (await action(args(request))) as Response;
}

function viewAsCookie(response: Response): string {
  const header = response.headers.get("set-cookie");
  if (!header) throw new Error("no set-cookie on the impersonation response");
  return header.split(";")[0];
}

/**
 * A plain portal navigation — no query string, which is the whole point: this
 * is the request a tab click sends once the landing URL's params are gone.
 */
async function portalRequest(path: string, personId: string, extraCookie?: string) {
  const url = `https://x.test${path}`;
  const session = (await createLoginSession(new Request(url), personId)).split(";")[0];
  return new Request(url, {
    headers: { cookie: extraCookie ? `${session}; ${extraCookie}` : session },
  });
}

describe("the impersonated portal is scoped to the event the organizer selected", () => {
  it("must fire: the second event's speaker portal survives a bare tab navigation", async () => {
    const started = await startViewAs(fixture.adminId, other.speakerId, `?event=${other.slug}`);
    expect(started.status).toBe(302);
    expect(started.headers.get("location")).toBe("/portal");

    // The tab click. No `?event=`, no admin-selection cookie (Path=/admin).
    const context = await portalContext(
      await portalRequest("/portal/tasks", fixture.adminId, viewAsCookie(started)),
    );

    expect(context.actor.person.id).toBe(other.speakerId);
    expect(context.actor.impersonatedBy?.id).toBe(fixture.adminId);
    // Asserted by value in both directions: the default event is the failure.
    expect(context.event.id).toBe(other.eventId);
    expect(context.event.id).not.toBe(fixture.eventId);

    // The defect this exists for was a confident, completely EMPTY portal.
    const submissions = await loadSubmissions(context.actor.person.id, context.event.id);
    expect(submissions.length).toBeGreaterThan(0);
  });

  it("must fire: the route binds the RIGHT event into the cookie it mints", async () => {
    // `startImpersonationCookie` now requires an eventId, so the compiler
    // guarantees some event was passed. It cannot guarantee the CORRECT one —
    // `admin.id` and `event.id` are both strings, and a mint site resolving the
    // default event instead of the selected one type-checks perfectly. So this
    // reads the claim back out of the real cookie and pins it to the event the
    // form asked for, in both directions.
    for (const [target, query, expected] of [
      [other.speakerId, `?event=${other.slug}`, () => other.eventId],
      [fixture.speakerIds[0], "", () => fixture.eventId],
    ] as const) {
      const started = await startViewAs(fixture.adminId, target, query);
      const claim = await readImpersonationCookie(
        new Request("https://x.test/portal", { headers: { cookie: viewAsCookie(started) } }),
      );
      expect(claim?.eventId, `no event bound for ${query || "(no query)"}`).toBe(expected());
    }
  });

  it("must NOT fire: the default event's speaker portal is unchanged", async () => {
    const started = await startViewAs(fixture.adminId, fixture.speakerIds[0]);
    expect(started.status).toBe(302);

    const context = await portalContext(
      await portalRequest("/portal", fixture.adminId, viewAsCookie(started)),
    );
    expect(context.actor.person.id).toBe(fixture.speakerIds[0]);
    expect(context.event.id).toBe(fixture.eventId);
    expect(context.event.id).not.toBe(other.eventId);
  });

  it("must NOT fire: an ordinary speaker with no impersonation still gets the default event", async () => {
    const context = await portalContext(
      await portalRequest("/portal/tasks", fixture.speakerIds[0]),
    );
    expect(context.actor.impersonatedBy).toBeNull();
    expect(context.event.id).toBe(fixture.eventId);
  });

  it("must NOT fire: a cookie minted by an admin does nothing in a speaker's browser", async () => {
    // Condition 3 in impersonation.server.ts. The event binding must ride on the
    // HONOURED claim, not on the raw cookie — otherwise a leaked cookie would
    // still move somebody else's portal to another event.
    const started = await startViewAs(fixture.adminId, other.speakerId, `?event=${other.slug}`);

    const context = await portalContext(
      await portalRequest("/portal", fixture.speakerIds[0], viewAsCookie(started)),
    );
    expect(context.actor.person.id).toBe(fixture.speakerIds[0]);
    expect(context.actor.impersonatedBy).toBeNull();
    expect(context.event.id).toBe(fixture.eventId);
  });
});

describe("the launcher fails loudly instead of rendering an empty portal", () => {
  it("must fire: a speaker who is not on the selected event is refused", async () => {
    // The sibling reviewer route 404s "No reviewer exists for this event."
    // (review.impersonate.tsx:29). This one used to return 200 and render a
    // confident, empty portal for a speaker the organizer could see one page back.
    await expect(
      startViewAs(fixture.adminId, fixture.speakerIds[0], `?event=${other.slug}`),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("must NOT fire: the guards that already existed still bite", async () => {
    // A speaker cannot mint impersonation authority.
    await expect(
      startViewAs(fixture.speakerIds[0], fixture.speakerIds[1]),
    ).rejects.toMatchObject({ status: 403 });
    // Impersonating another admin muddles the audit trail.
    await expect(startViewAs(fixture.adminId, fixture.adminId)).rejects.toMatchObject({
      status: 400,
    });
    // An id that does not exist.
    await expect(
      startViewAs(fixture.adminId, "00000000-0000-4000-8000-000000000999"),
    ).rejects.toMatchObject({ status: 404 });
  });
});
