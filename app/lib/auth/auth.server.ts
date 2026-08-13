/**
 * Server side of the magic-link flow and the session guards.
 *
 * Flow: POST /login -> issueMagicLink -> Mailer -> GET /auth/verify?token=
 *       -> consumeMagicLink -> createLoginSession -> Set-Cookie -> redirect.
 */
import { and, eq, gt, isNull, lt, sql } from "drizzle-orm";
import { redirect } from "react-router";

import { getDb } from "~/db/client.server";
import {
  authTokens,
  people,
  sessionsAuth,
  type AuthTokenPurpose,
  type Person,
} from "~/db/schema";
import { DEMO_ACCOUNTS, type DemoRole } from "~/lib/demo";
import { appUrl, isDemoMode, isDev, requireSecret } from "~/lib/env.server";
import { getMailer } from "~/lib/mail/mailer.server";
import {
  RATE_LIMIT_POLICIES,
  enforceRateLimit,
  requestClientIdentifier,
} from "~/lib/rate-limit.server";

import {
  SESSION_COOKIE_NAME,
  SESSION_TTL_SECONDS,
  clearSessionCookie,
  readCookie,
  serializeSessionCookie,
  signCookieValue,
  unsignCookieValue,
} from "./cookie";
import {
  MAGIC_LINK_TTL_MS,
  hashToken,
  magicLinkUrl,
  signMagicLink,
  verifyMagicLink,
} from "./tokens";

/** Cookies are Secure everywhere except plain-http local dev. */
function cookieSecure(request: Request): boolean {
  return new URL(request.url).protocol === "https:";
}

/* --------------------------------------------------------- people */

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** Find a person by email, creating a speaker-role record if they are new. */
export async function findOrCreatePerson(
  email: string,
  defaults: Partial<Person> = {},
): Promise<Person> {
  const db = getDb();
  const normalized = normalizeEmail(email);

  const existing = await db.query.people.findFirst({
    where: eq(people.email, normalized),
  });
  if (existing) return existing;

  const [created] = await db
    .insert(people)
    .values({
      email: normalized,
      role: defaults.role ?? "speaker",
      fullName: defaults.fullName ?? null,
    })
    .returning();
  return created;
}

/* ----------------------------------------------------- magic links */

export interface IssuedMagicLink {
  person: Person;
  url: string;
  expiresAt: Date;
}

/**
 * What the mailer actually reported about one magic link — never an inference.
 *
 * `"sent"` is the ONLY value that may be shown to a human as a delivery claim,
 * and it is reachable only when a driver that {@link Mailer.observesDelivery}
 * returned `ok`. The console driver returns `ok: true` unconditionally and
 * cannot fail, so treating "the call did not throw" as "sent" produced a claim
 * the system had no way to observe. Each of the other three values is a
 * different truth, and collapsing them would put the unfalsifiable claim back:
 *
 * - `"logged"` — the driver cannot deliver. The link exists in the Worker log.
 * - `"failed"` — the driver reported a failure. Deliberately NOT "the provider
 *                refused": `ResendMailer` returns `ok: false` for a 403 AND for
 *                a socket that hung up mid-request, and in the second case
 *                nobody knows whether Resend saw the message. All this state
 *                asserts is the thing actually observed — no confirmation.
 * - `"unknown"` — the send never reached a mailer at all (a rate limit threw
 *                 first). Indeterminate for a different reason; say so.
 */
export type MagicLinkDeliveryState = "sent" | "logged" | "failed" | "unknown";

export interface MagicLinkDelivery {
  state: MagicLinkDeliveryState;
  /** Mailer that handled it — "console", "resend", "memory". */
  driver: string;
  /** Provider or transport error, when there was one. */
  error?: string;
}

/** An issued link plus the observed outcome of handing it to the mailer. */
export interface SentMagicLink extends IssuedMagicLink {
  delivery: MagicLinkDelivery;
}

/**
 * Mint a magic link. Only the SHA-256 of the token is persisted, so a database
 * leak does not hand out logins.
 */
export async function issueMagicLink(options: {
  request: Request;
  email: string;
  redirectTo?: string;
  personDefaults?: Partial<Person>;
}): Promise<IssuedMagicLink> {
  const db = getDb();
  const person = await findOrCreatePerson(options.email, options.personDefaults);
  const expiresAt = new Date(Date.now() + MAGIC_LINK_TTL_MS);
  const jti = crypto.randomUUID();

  const token = await signMagicLink(
    { jti, sub: person.id, exp: expiresAt.getTime() },
    requireSecret("MAGIC_LINK_SECRET"),
  );

  await db.insert(authTokens).values({
    id: jti,
    personId: person.id,
    tokenHash: await hashToken(token),
    purpose: "magic_link",
    redirectTo: options.redirectTo ?? null,
    expiresAt,
  });

  return {
    person,
    expiresAt,
    url: magicLinkUrl(appUrl(options.request), token, options.redirectTo),
  };
}

/**
 * Issue a link, hand it to the configured Mailer, and report what the mailer
 * said. The `MailResult` used to be dropped on the floor, which left every
 * caller with one bit — "this call did not throw" — and no way to distinguish
 * a Resend 200 from a console log line.
 *
 * A provider rejection is still a resolved promise: the reviewer invite must
 * not un-provision someone because their mailbox bounced. The failure is
 * carried in `delivery`, not thrown.
 */
export async function sendMagicLink(options: {
  request: Request;
  email: string;
  redirectTo?: string;
  personDefaults?: Partial<Person>;
}): Promise<SentMagicLink> {
  await enforceRateLimit({
    scope: "magic-link:email",
    identifier: normalizeEmail(options.email),
    policy: RATE_LIMIT_POLICIES.magicLinkEmail,
    message: "Too many sign-in links were requested for this email. Please wait and try again.",
  });
  await enforceRateLimit({
    scope: "magic-link:ip",
    identifier: requestClientIdentifier(options.request),
    policy: RATE_LIMIT_POLICIES.magicLinkIp,
    message: "Too many sign-in links were requested from this connection. Please wait and try again.",
  });

  const issued = await issueMagicLink(options);
  const mailer = getMailer();
  const result = await mailer.send({
    to: issued.person.email,
    subject: "Your callboard sign-in link",
    text: [
      "Sign in to callboard by opening this link:",
      "",
      issued.url,
      "",
      "The link expires in 15 minutes. If you did not request it, ignore this email.",
    ].join("\n"),
  });

  const state: MagicLinkDeliveryState = !mailer.observesDelivery
    ? "logged"
    : result.ok
      ? "sent"
      : "failed";
  return {
    ...issued,
    delivery: { state, driver: mailer.name, ...(result.error ? { error: result.error } : {}) },
  };
}

/**
 * Start a public CFP account flow without granting authority before mailbox
 * ownership is proven. The person row and magic-link token may be created now,
 * but a web session is created only by /auth/verify after token redemption.
 */
export async function requestCfpSignup(options: {
  request: Request;
  email: string;
  eventId: string;
  fullName: string;
  redirectTo: string;
}): Promise<IssuedMagicLink> {
  await enforceRateLimit({
    scope: `cfp:${options.eventId}:inline-signup`,
    identifier: requestClientIdentifier(options.request),
    policy: RATE_LIMIT_POLICIES.inlineSignupIp,
    message: "Too many submission sign-ins were requested from this connection. Please wait and try again.",
  });

  return sendMagicLink({
    ...options,
    personDefaults: { fullName: options.fullName, role: "speaker" },
  });
}

export type ConsumeFailure =
  | "invalid"
  | "expired"
  | "revoked"
  | "unknown_person"
  | "wrong_purpose"
  | "exhausted";
export type ConsumeResult =
  | { ok: true; person: Person; redirectTo: string | null }
  | { ok: false; reason: ConsumeFailure };

/**
 * How many times one link may be redeemed inside its 15-minute TTL.
 *
 * Not 1: Outlook Safe Links, the Gmail image proxy, and corporate AV scanners
 * fetch the URL before the human clicks, so a strictly single-use token is dead
 * on arrival. Not unbounded either — a link that leaks (forwarded mail, a shared
 * screen, a proxy log) would otherwise be a login oracle for the whole window.
 * Five covers prefetch + the human + a refresh, and nothing else.
 */
export const MAX_MAGIC_LINK_USES = 5;

/**
 * Validate a magic-link token and return its person.
 *
 * Every check here is a check the token itself cannot satisfy by being
 * well-signed: the row must still exist, be for THIS purpose, belong to the
 * person the payload claims, and still have redemptions left. The use counter
 * is incremented by a CONDITIONAL update — the cap lives in the WHERE clause, so
 * two concurrent redemptions cannot both read `useCount = 4` and both proceed.
 */
export async function consumeMagicLink(
  token: string,
  expectedPurpose: AuthTokenPurpose = "magic_link",
): Promise<ConsumeResult> {
  const verified = await verifyMagicLink(token, requireSecret("MAGIC_LINK_SECRET"));
  if (!verified.ok) {
    return { ok: false, reason: verified.reason === "expired" ? "expired" : "invalid" };
  }

  const db = getDb();
  const hash = await hashToken(token);
  const row = await db.query.authTokens.findFirst({
    where: and(eq(authTokens.id, verified.payload.jti), eq(authTokens.tokenHash, hash)),
  });

  if (!row) return { ok: false, reason: "invalid" };
  if (row.revokedAt) return { ok: false, reason: "revoked" };
  if (row.expiresAt.getTime() <= Date.now()) return { ok: false, reason: "expired" };
  // An invite token is not a sign-in token, even though both are signed with the
  // same key and land on the same route.
  if (row.purpose !== expectedPurpose) return { ok: false, reason: "wrong_purpose" };
  // The signature covers the payload, so a mismatch here means the row and the
  // token disagree about who this is — never resolve that in the caller's favour.
  if (verified.payload.sub !== row.personId) return { ok: false, reason: "invalid" };

  const person = await db.query.people.findFirst({ where: eq(people.id, row.personId) });
  if (!person) return { ok: false, reason: "unknown_person" };

  const now = new Date();
  const claimed = await db
    .update(authTokens)
    .set({
      consumedAt: sql`coalesce(${authTokens.consumedAt}, ${now.getTime()})`,
      useCount: sql`${authTokens.useCount} + 1`,
    })
    .where(
      and(
        eq(authTokens.id, row.id),
        isNull(authTokens.revokedAt),
        lt(authTokens.useCount, MAX_MAGIC_LINK_USES),
        gt(authTokens.expiresAt, now),
      ),
    )
    .returning({ useCount: authTokens.useCount });

  // Zero rows back means the WHERE clause rejected it — cap reached, or the row
  // was revoked/expired between the read above and this write.
  if (claimed.length === 0) return { ok: false, reason: "exhausted" };

  return { ok: true, person, redirectTo: row.redirectTo };
}

/* -------------------------------------------------------- sessions */

/** Create a web session row and return the `Set-Cookie` header value. */
export async function createLoginSession(
  request: Request,
  personId: string,
): Promise<string> {
  const db = getDb();
  const expiresAt = new Date(Date.now() + SESSION_TTL_SECONDS * 1000);
  const [row] = await db
    .insert(sessionsAuth)
    .values({
      personId,
      expiresAt,
      lastSeenAt: new Date(),
      userAgent: request.headers.get("user-agent")?.slice(0, 255) ?? null,
    })
    .returning();

  const signed = await signCookieValue(row.id, requireSecret("SESSION_SECRET"));
  return serializeSessionCookie(signed, { secure: cookieSecure(request) });
}

/** Revoke the current session and return the clearing `Set-Cookie` value. */
export async function destroyLoginSession(request: Request): Promise<string> {
  const sessionId = await readSessionId(request);
  if (sessionId) {
    await getDb()
      .update(sessionsAuth)
      .set({ revokedAt: new Date() })
      .where(eq(sessionsAuth.id, sessionId));
  }
  return clearSessionCookie({ secure: cookieSecure(request) });
}

async function readSessionId(request: Request): Promise<string | null> {
  const raw = readCookie(request.headers.get("cookie"), SESSION_COOKIE_NAME);
  return unsignCookieValue(raw, requireSecret("SESSION_SECRET"));
}

/** The signed-in person, or null. Never throws. */
export async function getCurrentPerson(request: Request): Promise<Person | null> {
  const sessionId = await readSessionId(request);
  if (!sessionId) return null;

  const row = await getDb().query.sessionsAuth.findFirst({
    where: and(
      eq(sessionsAuth.id, sessionId),
      isNull(sessionsAuth.revokedAt),
      gt(sessionsAuth.expiresAt, new Date()),
    ),
  });
  if (!row) return null;

  return (
    (await getDb().query.people.findFirst({ where: eq(people.id, row.personId) })) ?? null
  );
}

/* ---------------------------------------------------------- guards */

function loginRedirect(request: Request): Response {
  const url = new URL(request.url);
  const next = `${url.pathname}${url.search}`;
  return redirect(`/login?redirectTo=${encodeURIComponent(next)}`);
}

/** Portal guard: any signed-in person. Throws a redirect to /login otherwise. */
export async function requireUser(request: Request): Promise<Person> {
  const person = await getCurrentPerson(request);
  if (!person) throw loginRedirect(request);
  return person;
}

/**
 * Admin guard. A signed-in non-admin gets 403, not a login loop — bouncing them
 * back to /login when they are already authenticated is the classic redirect
 * loop, and it hides the real problem.
 */
export async function requireAdmin(request: Request): Promise<Person> {
  const person = await getCurrentPerson(request);
  if (!person) throw loginRedirect(request);
  if (person.role !== "admin") {
    throw new Response("Forbidden — admin access required.", { status: 403 });
  }
  return person;
}

/* ------------------------------------------------------ demo login */

/**
 * One-click demo sign-in. Callers MUST check `isDemoMode()` first — this
 * function does not gate itself, so the check lives at the route boundary
 * where it is visible in a diff.
 */
export async function demoSignIn(
  request: Request,
  role: DemoRole,
): Promise<{ cookie: string; person: Person } | null> {
  const db = getDb();
  const person = await db.query.people.findFirst({
    where: eq(people.email, DEMO_ACCOUNTS[role].email),
  });
  if (!person) return null;
  return { cookie: await createLoginSession(request, person.id), person };
}

/**
 * May the issued magic link be printed on screen instead of only emailed?
 *
 * Two situations qualify, and neither is production:
 *   - `isDev()` — the console mailer is the only mailer, so a link that is not
 *     rendered is a link nobody can open.
 *   - `isDemoMode()` — a DISPOSABLE demo Worker, which pins `MAIL_DRIVER` to
 *     `"console"` (wrangler.demo.example.jsonc) and therefore has the same
 *     problem with none of dev's local console to read. Without this, no new
 *     speaker identity can be created on the judged deployment at all: the CFP
 *     wizard says "we emailed a sign-in link" and the link exists only in a
 *     Worker log.
 *
 * `isDemoMode()` is not a single flag — it needs `DEPLOYMENT_PROFILE=demo` AND
 * `DEMO_MODE=1` AND an unexpired `DEMO_EXPIRES_AT` (app/lib/demo-access.ts), so
 * a production Worker that accidentally sets one of them stays closed, and a
 * demo Worker closes itself again at its deadline. A deployed non-demo config
 * reveals nothing, which is what `auth.server.reveal.test.ts` pins.
 */
export function shouldRevealMagicLink(): boolean {
  return isDev() || isDemoMode();
}
