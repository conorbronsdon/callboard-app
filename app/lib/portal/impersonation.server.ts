/**
 * Admin "View as speaker" impersonation.
 *
 * The admin's own login session is NEVER swapped. Impersonation is a second,
 * separate signed cookie that says "this admin is currently looking through
 * that speaker's eyes"; ending it deletes one cookie and the admin session is
 * exactly as it was. That is what makes the round-trip cheap and safe —
 * admin → portal → back to /admin with no re-login, which is the acceptance
 * criterion for this feature.
 *
 * Three things have to hold for the impersonation to be honoured, checked on
 * EVERY request (`readImpersonation`):
 *   1. the cookie's HMAC verifies against SESSION_SECRET (unforgeable), and
 *   2. the caller's real session belongs to an `admin`, and
 *   3. the admin id INSIDE the cookie equals the caller's real person id.
 *
 * (3) is the one that is easy to leave out. Without it a leaked cookie would
 * work in any admin's browser; with it the cookie is bound to the one account
 * that minted it and is inert everywhere else.
 *
 * ── Why the EVENT is in the cookie ──────────────────────────────────────────
 * The reviewer sibling puts its event in the redirect
 * (`review.impersonate.tsx:31`) and that is enough, because `/review` is one
 * flat route. The portal is a five-tab layout (`portal.layout.tsx:53-59`), and
 * a `?event=` on the landing URL is gone the moment a tab is clicked: the
 * selection cookie is `Path=/admin` so it is never sent here, and
 * `currentEvent` refuses to read it off a non-admin path anyway. A
 * redirect-only fix would therefore land correctly and then silently fall back
 * to the DEFAULT event on the first navigation.
 *
 * So the event rides in the impersonation cookie itself, decided once at
 * mint time from the event the organizer had selected. `Path=/` means it is
 * sent with every portal request, which is the property the query param does
 * not have. It carries no authority — it selects between events the admin who
 * minted it could already reach — and it is only honoured when all three
 * conditions above hold, so a leaked or forged cookie cannot move anybody
 * else's portal.
 */
import { eq } from "drizzle-orm";

import { getDb } from "~/db/client.server";
import { people, type Person } from "~/db/schema";
import { readCookie, signCookieValue, unsignCookieValue } from "~/lib/auth/cookie";
import { requireUser } from "~/lib/auth/auth.server";
import { requireSecret } from "~/lib/env.server";

export const IMPERSONATION_COOKIE = "cb_view_as";

/** Short by design: a forgotten impersonation is a confusing support ticket. */
const IMPERSONATION_TTL_SECONDS = 60 * 60 * 4;

function cookieSecure(request: Request): boolean {
  return new URL(request.url).protocol === "https:";
}

function serialize(value: string, options: { secure: boolean; maxAgeSeconds: number }): string {
  const attrs = [
    `${IMPERSONATION_COOKIE}=${encodeURIComponent(value)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${options.maxAgeSeconds}`,
  ];
  if (options.secure) attrs.push("Secure");
  return attrs.join("; ");
}

/**
 * `Set-Cookie` that starts impersonating `targetId` as `adminId`, viewing
 * `eventId`. Ids are uuids, so `:` stays an unambiguous separator.
 *
 * `eventId` is REQUIRED, and that is the point: a mint site that omits it
 * reintroduces the exact default-event fallback this binding exists to remove,
 * silently and with a 200. The compiler is the only check that cannot be
 * forgotten, so the invariant lives in the signature rather than in a comment.
 *
 * The read side still tolerates a two-segment value (`readImpersonationCookie`)
 * because cookies minted before this existed are sitting in browsers with a
 * four-hour TTL. That asymmetry is deliberate: lenient about what already
 * exists, strict about what this code creates.
 */
export async function startImpersonationCookie(
  request: Request,
  adminId: string,
  targetId: string,
  eventId: string,
): Promise<string> {
  const signed = await signCookieValue(
    `${adminId}:${targetId}:${eventId}`,
    requireSecret("SESSION_SECRET"),
  );
  return serialize(signed, {
    secure: cookieSecure(request),
    maxAgeSeconds: IMPERSONATION_TTL_SECONDS,
  });
}

/** `Set-Cookie` that ends impersonation. The login session is untouched. */
export function stopImpersonationCookie(request: Request): string {
  return serialize("", { secure: cookieSecure(request), maxAgeSeconds: 0 });
}

export interface ImpersonationClaim {
  adminId: string;
  targetId: string;
  /** The event the organizer was looking at. Null for a cookie minted before. */
  eventId: string | null;
}

/** Verify the cookie's signature and shape. Does NOT check the caller's role. */
export async function readImpersonationCookie(
  request: Request,
): Promise<ImpersonationClaim | null> {
  const raw = readCookie(request.headers.get("cookie"), IMPERSONATION_COOKIE);
  const value = await unsignCookieValue(raw, requireSecret("SESSION_SECRET"));
  if (!value) return null;
  const [adminId, targetId, eventId] = value.split(":");
  if (!adminId || !targetId) return null;
  // A two-segment cookie is one minted before the event was bound. It stays
  // valid and resolves the event the old way rather than signing the organizer
  // out mid-preview.
  return { adminId, targetId, eventId: eventId || null };
}

/**
 * Who the portal should render for.
 *
 * `person` is the speaker whose portal is on screen. `impersonatedBy` is the
 * admin behind it, or null in the ordinary case. Routes read `person` and never
 * have to know which it is — only the layout's banner cares.
 */
export interface PortalActor {
  person: Person;
  impersonatedBy: Person | null;
  /**
   * The event this preview is pinned to, set ONLY when the impersonation was
   * honoured. Null for an ordinary speaker, who resolves the event the usual
   * way — see `portalContext`.
   */
  boundEventId: string | null;
}

export function isImpersonating(actor: PortalActor): boolean {
  return actor.impersonatedBy !== null;
}

/**
 * Portal guard. Redirects to /login when signed out (via `requireUser`), and
 * resolves impersonation when all three conditions hold.
 */
export async function requirePortalActor(request: Request): Promise<PortalActor> {
  const real = await requireUser(request);
  const own: PortalActor = { person: real, impersonatedBy: null, boundEventId: null };

  const claim = await readImpersonationCookie(request);
  if (!claim) return own;

  // Condition 2 and 3: an admin session, and the cookie was minted BY this admin.
  if (real.role !== "admin" || claim.adminId !== real.id) return own;

  const target = await getDb().query.people.findFirst({
    where: eq(people.id, claim.targetId),
  });
  if (!target) return own;

  // The event travels only on a claim that survived all three conditions, so a
  // leaked cookie cannot move a bystander's portal to another event either.
  return { person: target, impersonatedBy: real, boundEventId: claim.eventId };
}

/**
 * Writes performed while impersonating are performed AS the speaker — that is
 * the point of the feature (an organiser fixing a speaker's bio for them). The
 * caller passes this to anything that records an actor, so a comm log or audit
 * row can say who really did it.
 */
export function actingAs(actor: PortalActor): { personId: string; onBehalfOf: string | null } {
  return {
    personId: actor.person.id,
    onBehalfOf: actor.impersonatedBy?.id ?? null,
  };
}
