/**
 * Signed session cookie. Pure — WebCrypto + string handling only.
 *
 * `SameSite=Lax`, never `Strict`: every login here starts with a click in an
 * email client, which is a cross-site navigation. `Strict` would drop the
 * cookie on exactly the flow this product depends on.
 */
import { hmacSign, hmacVerify } from "./tokens";

export const SESSION_COOKIE_NAME = "cb_session";
export const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days

/** `value.signature` — the value is the `sessions_auth` row id. */
export async function signCookieValue(value: string, secret: string): Promise<string> {
  return `${value}.${await hmacSign(value, secret)}`;
}

/** Returns the value if the signature checks out, else null. */
export async function unsignCookieValue(
  signed: string | null | undefined,
  secret: string,
): Promise<string | null> {
  if (!signed) return null;
  const index = signed.lastIndexOf(".");
  if (index <= 0 || index === signed.length - 1) return null;
  const value = signed.slice(0, index);
  const signature = signed.slice(index + 1);
  return (await hmacVerify(value, signature, secret)) ? value : null;
}

/**
 * Minimal cookie-header parser — one header, one name, no dependencies.
 *
 * A malformed percent-escape (`%`, `%zz`, a truncated `%E0%A4%A`) makes
 * `decodeURIComponent` throw a URIError, and every caller reads cookies on the
 * request path: `cb_session` on every authenticated route, `cb_admin_event` on
 * every `/admin` page. Letting that throw turns one tampered or corrupted
 * cookie into a 500 on every page for the cookie's 30-day life, with no way out
 * that does not involve devtools. So a value that cannot be decoded is treated
 * as ABSENT: the session guard sends the caller to /login, and the event
 * selector falls back to the default event. Both are the states those callers
 * already handle for a missing cookie.
 *
 * Fail-safe, not fail-open: nothing downstream trusts an undecodable value —
 * the session cookie is HMAC-verified after this returns, so "absent" is the
 * strictly smaller authority, never the larger one.
 */
export function readCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(eq + 1).trim());
    } catch {
      return null;
    }
  }
  return null;
}

export interface CookieOptions {
  secure: boolean;
  maxAgeSeconds?: number;
}

export function serializeSessionCookie(signedValue: string, options: CookieOptions): string {
  const attrs = [
    `${SESSION_COOKIE_NAME}=${encodeURIComponent(signedValue)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${options.maxAgeSeconds ?? SESSION_TTL_SECONDS}`,
  ];
  if (options.secure) attrs.push("Secure");
  return attrs.join("; ");
}

export function clearSessionCookie(options: { secure: boolean }): string {
  const attrs = [`${SESSION_COOKIE_NAME}=`, "Path=/", "HttpOnly", "SameSite=Lax", "Max-Age=0"];
  if (options.secure) attrs.push("Secure");
  return attrs.join("; ");
}
