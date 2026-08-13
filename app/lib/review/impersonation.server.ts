import { readCookie, signCookieValue, unsignCookieValue } from "~/lib/auth/cookie";
import { requireSecret } from "~/lib/env.server";

/** Separate from cb_view_as so reviewer and speaker previews cannot bleed together. */
export const REVIEWER_IMPERSONATION_COOKIE = "cb_review_as";
const REVIEWER_IMPERSONATION_TTL_SECONDS = 60 * 60 * 2;

function cookieSecure(request: Request): boolean {
  return new URL(request.url).protocol === "https:";
}

function serialize(value: string, options: { secure: boolean; maxAgeSeconds: number }): string {
  const attributes = [
    `${REVIEWER_IMPERSONATION_COOKIE}=${encodeURIComponent(value)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${options.maxAgeSeconds}`,
  ];
  if (options.secure) attributes.push("Secure");
  return attributes.join("; ");
}

export async function startReviewerImpersonationCookie(
  request: Request,
  adminId: string,
  targetId: string,
): Promise<string> {
  const signed = await signCookieValue(
    `${adminId}:${targetId}`,
    requireSecret("SESSION_SECRET"),
  );
  return serialize(signed, {
    secure: cookieSecure(request),
    maxAgeSeconds: REVIEWER_IMPERSONATION_TTL_SECONDS,
  });
}

export function stopReviewerImpersonationCookie(request: Request): string {
  return serialize("", { secure: cookieSecure(request), maxAgeSeconds: 0 });
}

export async function readReviewerImpersonationCookie(
  request: Request,
): Promise<{ adminId: string; targetId: string } | null> {
  const raw = readCookie(request.headers.get("cookie"), REVIEWER_IMPERSONATION_COOKIE);
  const value = await unsignCookieValue(raw, requireSecret("SESSION_SECRET"));
  if (!value) return null;
  const [adminId, targetId] = value.split(":");
  return adminId && targetId ? { adminId, targetId } : null;
}
