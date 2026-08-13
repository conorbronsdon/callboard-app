/**
 * `POST /portal/impersonate` — an admin starts viewing as a speaker.
 *
 * Guarded by `requireAdmin`, so a speaker POSTing here gets 403 and never a
 * cookie. The admin's own session is untouched: this only adds a second cookie
 * (see `impersonation.server.ts`), which is what lets "Back to Admin Mode"
 * restore the admin session without a re-login.
 *
 * The launcher's form carries `?event=<slug>` because this route sits OUTSIDE
 * `/admin` and so never receives the organizer's selection cookie. Two things
 * follow from resolving it here rather than downstream:
 *
 *   1. The event is bound into the cookie, so the preview keeps it across all
 *      five portal tabs — a redirect carrying `?event=` would be dropped by the
 *      first tab click and fall back to the default event.
 *   2. A mismatch FAILS LOUDLY. `review.impersonate` 404s "No reviewer exists
 *      for this event"; this route had no event check at all, so the same
 *      mismatch returned 200 and rendered a confident, empty portal for a
 *      speaker the organizer could see one page back.
 */
import { redirect } from "react-router";
import { and, eq } from "drizzle-orm";

import { getDb } from "~/db/client.server";
import { eventPeople, people } from "~/db/schema";
import { requireAdmin } from "~/lib/auth/auth.server";
import { requireCurrentEvent } from "~/lib/event.server";
import { startImpersonationCookie } from "~/lib/portal/impersonation.server";
import type { Route } from "./+types/portal.impersonate";

export async function action({ request }: Route.ActionArgs) {
  const admin = await requireAdmin(request);
  const event = await requireCurrentEvent(request);

  const form = await request.formData();
  const personId = String(form.get("personId") ?? "");
  const target = await getDb().query.people.findFirst({ where: eq(people.id, personId) });
  if (!target) throw new Response("No such person.", { status: 404 });

  // Impersonating another admin buys nothing and muddles the audit trail.
  if (target.role === "admin") {
    throw new Response("Impersonation is for speaker accounts only.", { status: 400 });
  }

  const [attached] = await getDb()
    .select({ personId: eventPeople.personId })
    .from(eventPeople)
    .where(and(eq(eventPeople.eventId, event.id), eq(eventPeople.personId, target.id)))
    .limit(1);
  if (!attached) throw new Response("No speaker exists for this event.", { status: 404 });

  return redirect("/portal", {
    headers: {
      "set-cookie": await startImpersonationCookie(request, admin.id, target.id, event.id),
    },
  });
}

/** Nothing to render — a GET is a mis-click, not a page. */
export async function loader() {
  return redirect("/admin/view-as");
}
