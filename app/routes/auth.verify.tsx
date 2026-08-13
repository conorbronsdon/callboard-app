import { Link, redirect } from "react-router";

import { Shell } from "~/components/shell";
import { consumeMagicLink, createLoginSession } from "~/lib/auth/auth.server";
import { hasAnyReviewMembership } from "~/lib/review/access.server";
import type { Route } from "./+types/auth.verify";

const MESSAGES: Record<string, string> = {
  invalid: "That sign-in link is not valid. Request a new one.",
  expired: "That sign-in link has expired. Links last 15 minutes.",
  revoked: "That sign-in link was revoked. Request a new one.",
  unknown_person: "The account for that link no longer exists.",
  wrong_purpose: "That link is not a sign-in link. Request a new one.",
  exhausted: "That sign-in link has been used too many times. Request a new one.",
  missing: "No sign-in token in that link.",
};

function safeRedirect(value: string | null | undefined): string | null {
  if (!value) return null;
  if (!value.startsWith("/") || value.startsWith("//")) return null;
  return value;
}

function isReviewDestination(value: string): boolean {
  const path = value.split(/[?#]/)[0];
  return path === "/review" || path.startsWith("/review/");
}

export async function loader({ request }: Route.LoaderArgs) {
  const url = new URL(request.url);
  const token = url.searchParams.get("token");
  if (!token) return { reason: "missing" as const };

  const result = await consumeMagicLink(token);
  if (!result.ok) return { reason: result.reason };

  const cookie = await createLoginSession(request, result.person.id);
  const hasReviewMembership = await hasAnyReviewMembership(result.person.id);
  const defaultDestination = result.person.role === "admin"
    ? "/admin"
    : (hasReviewMembership ? "/review" : "/portal");
  const requested =
    safeRedirect(url.searchParams.get("redirectTo")) ??
    safeRedirect(result.redirectTo);
  // A requested /review path is a request, not authorization.
  // The teamless reviewer invite mints exactly that destination despite
  // creating no review-team membership, so honoring it ends at a 403.
  // Keeping this gate at verification time instead of mint time also covers
  // links already issued and destinations already stored in token rows,
  // which a mint-time fix could not protect.
  const destination =
    requested && (hasReviewMembership || !isReviewDestination(requested))
      ? requested
      : defaultDestination;

  throw redirect(destination, { headers: { "Set-Cookie": cookie } });
}

export default function Verify({ loaderData }: Route.ComponentProps) {
  return (
    <Shell title="Sign-in link">
      <p className="mb-4 text-sm text-red-600">
        {MESSAGES[loaderData.reason] ?? MESSAGES.invalid}
      </p>
      <Link className="underline" to="/login">
        Request a new link
      </Link>
    </Shell>
  );
}
