/**
 * `POST /admin/event` — persist the organizer's selected event.
 *
 * Why a resource route instead of a loader header: a React Router loader has no
 * reliable place to attach `Set-Cookie` for a nested layout, and making EVERY
 * admin loader write the header would be thirteen chances to forget one. A
 * redirecting action is the shape this repo already uses for every cookie it
 * mints (auth.verify, portal.impersonate, review.impersonate), so the switcher
 * reuses it: POST here, get a `Set-Cookie` plus a 302 back to the page the
 * organizer was already on. Every plain admin link they click afterwards
 * carries the cookie, which is the acceptance bar — a bare `?event=` query
 * param does not survive a nav click.
 */
import { eq } from "drizzle-orm";
import { redirect } from "react-router";

import { getDb } from "~/db/client.server";
import { events } from "~/db/schema";
import { requireAdmin } from "~/lib/auth/auth.server";
import {
  EVENT_COOKIE_PATH,
  eventCookieSecure,
  safeAdminRedirect,
  serializeEventCookie,
} from "~/lib/event.server";
import type { Route } from "./+types/admin.event";

export async function action({ request }: Route.ActionArgs) {
  await requireAdmin(request);

  const form = await request.formData();
  const slug = String(form.get("event") ?? "");
  const destination = safeAdminRedirect(String(form.get("redirectTo") ?? ""));

  const chosen = await getDb().query.events.findFirst({ where: eq(events.slug, slug) });
  // Unknown slug: navigate, write nothing. The previous selection survives,
  // which is the least surprising outcome for a chrome control.
  if (!chosen) return redirect(destination);

  return redirect(destination, {
    headers: {
      "set-cookie": serializeEventCookie(chosen.slug, {
        secure: eventCookieSecure(request),
      }),
    },
  });
}

/** Nothing to render here; a direct visit belongs on the dashboard. */
export async function loader() {
  return redirect(EVENT_COOKIE_PATH);
}
