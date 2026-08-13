import { redirect } from "react-router";

import { stopReviewerImpersonationCookie } from "~/lib/review/impersonation.server";
import type { Route } from "./+types/review.impersonate.stop";

function stop(request: Request) {
  return redirect("/admin/view-as", {
    headers: { "set-cookie": stopReviewerImpersonationCookie(request) },
  });
}

export async function action({ request }: Route.ActionArgs) {
  return stop(request);
}

export async function loader({ request }: Route.LoaderArgs) {
  return stop(request);
}
