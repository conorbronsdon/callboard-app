/**
 * Event resolution: param > cookie > oldest, and the two scopes that keep the
 * organizer's selection out of every non-admin surface.
 *
 * Every case here has its complement. "The cookie is honoured on /admin" proves
 * nothing on its own — a `currentEvent` that returned the cookie's event
 * unconditionally would pass it, and would also hand an organizer's selection
 * to the speaker portal. So each must-fire is paired with the must-not-fire
 * that a naive implementation would break.
 */
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { events } from "~/db/schema";
import {
  EVENT_COOKIE_NAME,
  EVENT_COOKIE_PATH,
  currentEvent,
  eventCookieSecure,
  isAdminSurface,
  listEvents,
  requireCurrentEvent,
  serializeEventCookie,
} from "~/lib/event.server";
import { installTestDb, type TestDbContext } from "~/test/db";
import {
  EVENT_SLUG,
  OTHER_EVENT_NAME,
  OTHER_EVENT_SLUG,
  seedDemoFixture,
  seedOtherEvent,
} from "~/test/fixtures";

let ctx: TestDbContext;

beforeEach(async () => {
  ctx = installTestDb();
  await seedDemoFixture(ctx.db);
  await seedOtherEvent(ctx.db);
});
afterEach(() => ctx.close());

/** A request carrying only the event-selection cookie — no auth needed here. */
function request(url: string, cookieSlug?: string): Request {
  return new Request(
    url,
    cookieSlug === undefined
      ? undefined
      : { headers: { cookie: `${EVENT_COOKIE_NAME}=${encodeURIComponent(cookieSlug)}` } },
  );
}

describe("currentEvent resolution order", () => {
  it("defaults to the OLDEST event when both are seeded and nothing is selected", async () => {
    const event = await currentEvent(request("https://x.test/admin"));
    // The seeded demo, scripts/smoke.mjs and every existing Playwright journey
    // are written against this default. It is load-bearing, not cosmetic.
    expect(event?.slug).toBe(EVENT_SLUG);
    expect(event?.slug).not.toBe(OTHER_EVENT_SLUG);
  });

  it("lets the cookie beat the default", async () => {
    const event = await currentEvent(request("https://x.test/admin", OTHER_EVENT_SLUG));
    expect(event?.slug).toBe(OTHER_EVENT_SLUG);
    expect(event?.name).toBe(OTHER_EVENT_NAME);
  });

  it("lets ?event beat the cookie, in both directions", async () => {
    const paramWins = await currentEvent(
      request(`https://x.test/admin?event=${EVENT_SLUG}`, OTHER_EVENT_SLUG),
    );
    expect(paramWins?.slug).toBe(EVENT_SLUG);

    // The mirror case, so this is precedence and not "the primary event always".
    const otherWins = await currentEvent(
      request(`https://x.test/admin?event=${OTHER_EVENT_SLUG}`, EVENT_SLUG),
    );
    expect(otherWins?.slug).toBe(OTHER_EVENT_SLUG);
  });

  it("keeps the pre-existing ?event behaviour for an unknown slug", async () => {
    // Unchanged from before the switcher: an explicit link to a slug that does
    // not exist resolves to nothing, so requireCurrentEvent 404s rather than
    // quietly showing a different event than the URL asked for.
    expect(await currentEvent(request("https://x.test/admin?event=no-such-event"))).toBeNull();
    await expect(
      requireCurrentEvent(request("https://x.test/admin?event=no-such-event")),
    ).rejects.toMatchObject({ status: 404 });
  });
});

describe("the selection cookie is untrusted input", () => {
  it("falls back to the default for a slug that never existed, without throwing", async () => {
    const event = await currentEvent(request("https://x.test/admin", "../../etc/passwd"));
    expect(event?.slug).toBe(EVENT_SLUG);
    // And the admin area stays reachable — a tampered cookie must not 404.
    await expect(requireCurrentEvent(request("https://x.test/admin", "junk"))).resolves.toMatchObject(
      { slug: EVENT_SLUG },
    );
  });

  /*
   * The complement the tamper case above was missing. "junk" and
   * "../../etc/passwd" are both WELL-FORMED cookie values — they exercise the
   * unknown-slug branch and never reach the decode. A malformed percent-escape
   * does, and an unguarded `decodeURIComponent` throws a URIError out of
   * `currentEvent`, which is a 500 on every /admin page for 30 days.
   */
  it("falls back to the default for a MALFORMED cookie value, without throwing", async () => {
    for (const raw of ["%", "%zz", "%E0%A4%A"]) {
      const tampered = new Request("https://x.test/admin", {
        headers: { cookie: `${EVENT_COOKIE_NAME}=${raw}` },
      });
      await expect(
        requireCurrentEvent(tampered),
        `cookie value ${raw} must fail safe to the default event`,
      ).resolves.toMatchObject({ slug: EVENT_SLUG });
    }

    // Must STILL fire: a valid selection is honoured by the same code path, so
    // the guard above cannot have been implemented by ignoring the cookie.
    const valid = await currentEvent(request("https://x.test/admin", OTHER_EVENT_SLUG));
    expect(valid?.slug).toBe(OTHER_EVENT_SLUG);
  });

  it("falls back to the default when the selected event is DELETED", async () => {
    const before = await currentEvent(request("https://x.test/admin", OTHER_EVENT_SLUG));
    expect(before?.slug).toBe(OTHER_EVENT_SLUG);

    await ctx.db.delete(events).where(eq(events.slug, OTHER_EVENT_SLUG));

    const after = await currentEvent(request("https://x.test/admin", OTHER_EVENT_SLUG));
    expect(after?.slug).toBe(EVENT_SLUG);
  });
});

describe("the cookie is scoped to the organizer chrome", () => {
  const adminPaths = ["/admin", "/admin/submissions", "/admin/agenda?view=list"];
  const otherPaths = [
    "/portal",
    "/portal/tasks",
    "/review",
    "/review/impersonate",
    "/api/upload",
    "/submit/frontier-ai-summit-2026/000000fo-0000-4000-8000-000000000001",
    "/",
    "/e/frontier-ai-summit-2026",
    "/administrator", // must not be swept in by a bare startsWith("/admin")
  ];

  it("must fire: an /admin request honours it", async () => {
    for (const path of adminPaths) {
      const event = await currentEvent(request(`https://x.test${path}`, OTHER_EVENT_SLUG));
      expect(event?.slug, `${path} should honour the selection`).toBe(OTHER_EVENT_SLUG);
    }
  });

  it("must NOT fire: portal, reviewer, public and API requests ignore it", async () => {
    for (const path of otherPaths) {
      const event = await currentEvent(request(`https://x.test${path}`, OTHER_EVENT_SLUG));
      expect(event?.slug, `${path} must not see the organizer's selection`).toBe(EVENT_SLUG);
    }
  });

  it("isAdminSurface draws the boundary at a path segment", () => {
    expect(isAdminSurface(new URL("https://x.test/admin"))).toBe(true);
    expect(isAdminSurface(new URL("https://x.test/admin/comms"))).toBe(true);
    expect(isAdminSurface(new URL("https://x.test/administrator"))).toBe(false);
    expect(isAdminSurface(new URL("https://x.test/portal/admin"))).toBe(false);
    expect(isAdminSurface(new URL("https://x.test/"))).toBe(false);
  });
});

describe("cookie serialization", () => {
  it("carries the attributes the repo requires and never SameSite=Strict", () => {
    const cookie = serializeEventCookie(OTHER_EVENT_SLUG, { secure: true });
    expect(cookie).toContain(`${EVENT_COOKIE_NAME}=${OTHER_EVENT_SLUG}`);
    expect(cookie).toContain(`Path=${EVENT_COOKIE_PATH}`);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Secure");
    // DECISIONS: Strict drops the cookie on the email-click navigation this
    // product is built around.
    expect(cookie).not.toContain("SameSite=Strict");
  });

  it("omits Secure over plain http so local dev still works", () => {
    expect(serializeEventCookie(EVENT_SLUG, { secure: false })).not.toContain("Secure");
    expect(eventCookieSecure(new Request("https://x.test/admin"))).toBe(true);
    expect(eventCookieSecure(new Request("http://localhost:5191/admin"))).toBe(false);
  });

  it("percent-encodes the value it writes", () => {
    expect(serializeEventCookie("a b;c", { secure: false })).toContain(
      `${EVENT_COOKIE_NAME}=a%20b%3Bc`,
    );
  });
});

describe("listEvents", () => {
  it("returns every event, oldest first, so the switcher lists the default first", async () => {
    const rows = await listEvents();
    expect(rows.map((row) => row.slug)).toEqual([EVENT_SLUG, OTHER_EVENT_SLUG]);
  });
});
