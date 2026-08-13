/**
 * `POST /portal/impersonate/stop` — "Back to Admin Mode".
 *
 * Clears only the impersonation cookie and returns to /admin. Deliberately
 * NOT guarded by `requireAdmin`: if a session somehow ends up holding a stale
 * impersonation cookie, the exit must always work. Clearing a cookie you
 * already hold grants nothing, and a stop route that can 403 is a trap door.
 */
import { redirect } from "react-router";

import { stopImpersonationCookie } from "~/lib/portal/impersonation.server";
import type { Route } from "./+types/portal.impersonate.stop";

function stop(request: Request) {
  return redirect("/admin", {
    headers: { "set-cookie": stopImpersonationCookie(request) },
  });
}

export async function action({ request }: Route.ActionArgs) {
  return stop(request);
}

/** A GET works too, so a bookmarked escape hatch is never a dead end. */
export async function loader({ request }: Route.LoaderArgs) {
  return stop(request);
}
