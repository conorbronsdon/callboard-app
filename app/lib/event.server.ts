/**
 * "Which event am I administering?"
 *
 * Resolution order, highest wins:
 *   1. `?event=<slug>` on the URL — an explicit, shareable override. Unknown
 *      slug still resolves to nothing, so `requireCurrentEvent` 404s rather
 *      than silently showing a different event than the link asked for.
 *   2. The `cb_admin_event` selection cookie, but ONLY on `/admin` surfaces.
 *   3. The oldest event by `createdAt` — the single-event demo default, which
 *      the seeded demo, the smoke script and the Playwright specs all depend on.
 *
 * ── Why the cookie is scoped twice ──────────────────────────────────────────
 * The cookie carries `Path=/admin` so a browser never sends it to the speaker
 * portal, the reviewer workspace, the public pages or `/api/*`. That is the
 * transport-level guarantee, and it is invisible to a unit test (a constructed
 * `Request` has whatever cookie header the test wrote). So `currentEvent` ALSO
 * refuses to read the cookie unless the request URL is an admin path. Two
 * independent scopes, and the second one is the one the suite can prove.
 *
 * ── Why the cookie is unsigned ──────────────────────────────────────────────
 * It selects between events the caller may already administer — admin authority
 * is the global `people.role`, checked by `requireAdmin` on every admin route,
 * and nothing here grants it. Forging the cookie buys an attacker the ability
 * to look at an event they could reach with `?event=` anyway. It is still
 * treated as untrusted input: an unknown or deleted slug falls back to the
 * default silently rather than throwing, because a stale cookie pointing at a
 * deleted event must not lock an organizer out of the admin area.
 */
import { asc, eq } from "drizzle-orm";

import { getDb } from "~/db/client.server";
import { readCookie } from "~/lib/auth/cookie";
import { events, type Event } from "~/db/schema";

export const EVENT_COOKIE_NAME = "cb_admin_event";

/** The organizer chrome, and the cookie's `Path`. */
export const EVENT_COOKIE_PATH = "/admin";

/** Long enough to survive a week of demo prep; it holds no authority. */
export const EVENT_COOKIE_TTL_SECONDS = 60 * 60 * 24 * 30;

/** Is this request for the organizer chrome the selection cookie belongs to? */
export function isAdminSurface(url: URL): boolean {
  return (
    url.pathname === EVENT_COOKIE_PATH || url.pathname.startsWith(`${EVENT_COOKIE_PATH}/`)
  );
}

export interface EventCookieOptions {
  secure: boolean;
  maxAgeSeconds?: number;
}

/**
 * `SameSite=Lax`, never `Strict` — the repo-wide rule (app/lib/auth/cookie.ts):
 * organizers arrive on these URLs from email clients, and `Strict` would drop
 * the cookie on exactly that navigation.
 */
export function serializeEventCookie(slug: string, options: EventCookieOptions): string {
  const attrs = [
    `${EVENT_COOKIE_NAME}=${encodeURIComponent(slug)}`,
    `Path=${EVENT_COOKIE_PATH}`,
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${options.maxAgeSeconds ?? EVENT_COOKIE_TTL_SECONDS}`,
  ];
  if (options.secure) attrs.push("Secure");
  return attrs.join("; ");
}

/** Whether a `Set-Cookie` this request emits may carry `Secure`. */
export function eventCookieSecure(request: Request): boolean {
  return new URL(request.url).protocol === "https:";
}

/**
 * Where the event switcher is allowed to send the browser next.
 *
 * `redirectTo` arrives in a form field, so it is attacker-controllable: only
 * same-origin paths inside the admin chrome are honoured, and anything else
 * collapses to `/admin`. `//evil.example` is a protocol-relative URL, not a
 * path, which is why a bare `startsWith("/")` test is not enough.
 *
 * `?event=` is stripped from the destination on purpose. Leaving it on would
 * let the old query param outrank the cookie that was just written, so the
 * first click after switching would silently bounce back.
 *
 * Lives here rather than in the route module: React Router's build only strips
 * `loader`/`action`/`headers`/`middleware` from a route, so a route that
 * exports anything else which depends on a `.server` module pulls that module
 * into the CLIENT graph — `npm run check` stays green and `npm run build`
 * fails.
 */
export function safeAdminRedirect(value: string | null | undefined): string {
  if (!value || !value.startsWith("/") || value.startsWith("//") || value.startsWith("/\\")) {
    return EVENT_COOKIE_PATH;
  }

  let url: URL;
  try {
    url = new URL(value, "https://callboard.invalid");
  } catch {
    return EVENT_COOKIE_PATH;
  }

  if (!isAdminSurface(url)) return EVENT_COOKIE_PATH;

  url.searchParams.delete("event");
  return `${url.pathname}${url.search}`;
}

/** The switcher's option list. Oldest first, so the default event leads it. */
export async function listEvents(limit = 20): Promise<{ id: string; name: string; slug: string }[]> {
  return getDb()
    .select({ id: events.id, name: events.name, slug: events.slug })
    .from(events)
    .orderBy(asc(events.createdAt))
    .limit(limit);
}

export async function currentEvent(request: Request): Promise<Event | null> {
  const db = getDb();
  const url = new URL(request.url);
  const slug = url.searchParams.get("event");

  if (slug) {
    return (await db.query.events.findFirst({ where: eq(events.slug, slug) })) ?? null;
  }

  if (isAdminSurface(url)) {
    const selected = readCookie(request.headers.get("cookie"), EVENT_COOKIE_NAME);
    if (selected) {
      const chosen = await db.query.events.findFirst({ where: eq(events.slug, selected) });
      // A hit wins; a miss falls through to the default rather than 404ing an
      // organizer whose selected event was renamed or deleted.
      if (chosen) return chosen;
    }
  }

  const [first] = await db.query.events.findMany({
    limit: 1,
    orderBy: [asc(events.createdAt)],
  });
  return first ?? null;
}

export async function requireCurrentEvent(request: Request): Promise<Event> {
  const event = await currentEvent(request);
  if (!event) {
    throw new Response("No event has been set up yet.", { status: 404 });
  }
  return event;
}
