/**
 * Issue #86 — which event does a REAL speaker's portal show?
 *
 * The view-as variant was fixed by binding the event into the impersonation
 * cookie (`portal.impersonate.test.tsx`). A speaker signing in for themselves
 * has no such cookie, so resolution fell through to `currentEvent(request)`,
 * which off `/admin` ignores the selection cookie and returns the OLDEST event.
 * A speaker whose only membership is the second event therefore got the first
 * one, and every portal query — all of them `personId AND eventId` — returned
 * nothing. A confident, completely empty portal.
 *
 * Every case asserts the resolved event BY ID in both directions and, where the
 * defect was visible, by the row counts the portal actually renders: an
 * implementation that returned the right id and still loaded the wrong event's
 * rows would pass a bare id assertion.
 *
 * The must-not-fires are the ones that keep this honest. "Always return the
 * speaker's newest membership" fixes the headline case and breaks a multi-event
 * speaker's `?event=`; "always return the request event" is the bug itself.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { eventPeople, people } from "~/db/schema";
import { createLoginSession } from "~/lib/auth/auth.server";
import { loadSubmissions, loadTasks, portalContext } from "~/lib/portal/portal.server";
import { installTestDb, type TestDbContext } from "~/test/db";
import {
  EVENT_SLUG,
  seedDemoFixture,
  seedOtherEvent,
  type DemoFixture,
  type OtherEventFixture,
} from "~/test/fixtures";

let ctx: TestDbContext;
let fixture: DemoFixture;
let other: OtherEventFixture;

beforeEach(async () => {
  ctx = installTestDb();
  fixture = await seedDemoFixture(ctx.db);
  other = await seedOtherEvent(ctx.db);
});
afterEach(() => ctx.close());

/**
 * A plain portal navigation. No `?event=`, no admin selection cookie — the
 * cookie is `Path=/admin` and would never be sent here anyway. This is exactly
 * what a speaker's browser sends after following a magic link.
 */
async function portalRequest(path: string, personId: string) {
  const url = `https://x.test${path}`;
  const session = (await createLoginSession(new Request(url), personId)).split(";")[0];
  return new Request(url, { headers: { cookie: session } });
}

describe("a real speaker lands in their OWN event's portal", () => {
  it("must fire: a speaker whose only membership is event 2 resolves event 2", async () => {
    const context = await portalContext(await portalRequest("/portal", other.speakerId));

    expect(context.actor.impersonatedBy).toBeNull();
    expect(context.event.id).toBe(other.eventId);
    // The default event is the failure mode, named explicitly.
    expect(context.event.id).not.toBe(fixture.eventId);

    // The defect was not a wrong label, it was an empty page.
    const submissions = await loadSubmissions(context.actor.person.id, context.event.id);
    expect(submissions.length).toBeGreaterThan(0);
    const tasks = await loadTasks(context.actor.person.id, context.event.id);
    expect(tasks.length).toBeGreaterThan(0);
  });

  it("must fire: it survives a bare tab navigation, not just the landing page", async () => {
    // Nothing in the resolution may depend on the URL, or the fix would evaporate
    // on the first click the way the `?event=` redirect did.
    for (const path of ["/portal", "/portal/tasks", "/portal/profile"]) {
      const context = await portalContext(await portalRequest(path, other.speakerId));
      expect(context.event.id, path).toBe(other.eventId);
    }
  });

  it("must fire: an explicit ?event= for an event they do NOT belong to is ignored", async () => {
    // A single-event speaker has exactly one correct answer. Honouring the query
    // param here would reintroduce the empty portal through a different door.
    const url = `https://x.test/portal?event=${EVENT_SLUG}`;
    const session = (await createLoginSession(new Request(url), other.speakerId)).split(";")[0];
    const context = await portalContext(new Request(url, { headers: { cookie: session } }));
    expect(context.event.id).toBe(other.eventId);
  });

  it("must NOT fire: a speaker who belongs only to the DEFAULT event is unchanged", async () => {
    const context = await portalContext(
      await portalRequest("/portal/tasks", fixture.speakerIds[0]),
    );
    expect(context.event.id).toBe(fixture.eventId);
    expect(context.event.id).not.toBe(other.eventId);

    const submissions = await loadSubmissions(context.actor.person.id, context.event.id);
    expect(submissions.length).toBeGreaterThan(0);
  });
});

describe("a multi-event speaker still steers", () => {
  /** Attach the default event's speaker to event 2 as well. */
  async function joinSecondEvent(personId: string) {
    await ctx.db.insert(eventPeople).values({
      eventId: other.eventId,
      personId,
      eventRole: "speaker",
      // Strictly later than the fixture's rows, so "newest membership" is the
      // SECOND event — which is what makes the next test discriminating.
      createdAt: new Date(Date.now() + 60_000),
    });
  }

  it("must NOT fire: with two memberships, ?event= decides", async () => {
    const speaker = fixture.speakerIds[0];
    await joinSecondEvent(speaker);

    for (const [slug, expected] of [
      [other.slug, other.eventId],
      [EVENT_SLUG, fixture.eventId],
    ] as const) {
      const url = `https://x.test/portal?event=${slug}`;
      const session = (await createLoginSession(new Request(url), speaker)).split(";")[0];
      const context = await portalContext(new Request(url, { headers: { cookie: session } }));
      expect(context.event.id, slug).toBe(expected);
    }
  });

  it("must NOT fire: with two memberships and no hint, the default event still wins", async () => {
    // `currentEvent` returns the oldest event, the speaker belongs to it, so it
    // stands. An implementation that unconditionally preferred the newest
    // membership would move an existing speaker's portal out from under them.
    const speaker = fixture.speakerIds[0];
    await joinSecondEvent(speaker);

    const context = await portalContext(await portalRequest("/portal", speaker));
    expect(context.event.id).toBe(fixture.eventId);
  });

  it("must NOT fire: an admin browsing their own portal keeps the default event", async () => {
    // The fixture's admin is attached to BOTH events as organizer.
    const context = await portalContext(await portalRequest("/portal", fixture.adminId));
    expect(context.actor.impersonatedBy).toBeNull();
    expect(context.event.id).toBe(fixture.eventId);
  });
});

describe("the fallbacks that existed before still hold", () => {
  it("a person with no membership at all resolves the request event", async () => {
    // The brand-new CFP account, mid-signup: the magic link has landed but no
    // `event_people` row exists yet. Falling back is what keeps the wizard from
    // 404ing between the sign-in and the first draft save.
    const [orphan] = await ctx.db
      .insert(people)
      .values({ email: "no-events@example.com", fullName: "No Events", role: "speaker" })
      .returning();

    const context = await portalContext(await portalRequest("/portal", orphan.id));
    expect(context.event.id).toBe(fixture.eventId);
  });
});
