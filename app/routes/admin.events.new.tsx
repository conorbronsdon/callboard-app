/**
 * `/admin/events/new` — the first way to make an event without running the seed.
 *
 * ── Why this changes no authorization ───────────────────────────────────────
 * Admin authority is the deployment-global `people.role`, checked by
 * `requireAdmin` here exactly as it is on every other `/admin` route. Creating
 * an event grants nobody anything: an organizer who can reach this form could
 * already administer every event in the deployment. There is no owner column,
 * no per-event role and no public signup, because adding one would be an authz
 * change wearing a feature's clothes.
 *
 * ── Why the action ends in a redirect with a cookie ─────────────────────────
 * Creating an event the organizer then has to go find is a bug with a happy
 * path. The successful action writes the same `cb_admin_event` selection cookie
 * the switcher writes and redirects to `/admin`, so the organizer lands INSIDE
 * the event they just made. The cookie is the only mechanism that survives a
 * plain nav click — a `?event=` query param does not.
 *
 * ── Why a newer event cannot become the default ─────────────────────────────
 * Nothing here touches default resolution. `currentEvent` falls back to the
 * OLDEST event by `createdAt` and this row is always newer, so the seeded demo,
 * the smoke script and every existing spec still open on the same event they
 * did before. That is asserted directly in the test beside this file rather
 * than left to inference.
 *
 * Validation mirrors `admin.settings.tsx` — same slug normaliser, same date
 * parsing, same `{ ok: false, error }` shape — so the create and edit screens
 * cannot disagree about what a legal event looks like. A slug collision is a
 * validation result, never a unique-index 500.
 */
import { eq } from "drizzle-orm";
import { redirect } from "react-router";

import { buttonClass, inputClass } from "~/components/portal-ui";
import { getDb } from "~/db/client.server";
import { events } from "~/db/schema";
import { requireAdmin } from "~/lib/auth/auth.server";
import {
  fromDateInput,
  invalidTimeZoneMessage,
  isValidTimeZone,
  normalizeSlug,
} from "~/lib/event-form";
import { eventCookieSecure, serializeEventCookie } from "~/lib/event.server";
import type { Route } from "./+types/admin.events.new";

const DEFAULT_TIMEZONE = "America/Los_Angeles";

interface SubmittedValues {
  name: string;
  slug: string;
  location: string;
  startsOn: string;
  endsOn: string;
  timezone: string;
}

function valuesFrom(formData: FormData): SubmittedValues {
  return {
    name: String(formData.get("name") ?? ""),
    slug: String(formData.get("slug") ?? ""),
    location: String(formData.get("location") ?? ""),
    startsOn: String(formData.get("startsOn") ?? ""),
    endsOn: String(formData.get("endsOn") ?? ""),
    timezone: String(formData.get("timezone") ?? ""),
  };
}

function invalid(error: string, values: SubmittedValues) {
  return { ok: false as const, error, values };
}

export async function loader({ request }: Route.LoaderArgs) {
  await requireAdmin(request);
  return { defaultTimezone: DEFAULT_TIMEZONE };
}

export async function action({ request }: Route.ActionArgs) {
  await requireAdmin(request);
  const formData = await request.formData();
  const values = valuesFrom(formData);
  const name = values.name.trim();

  if (!name) return invalid("Name is required.", values);
  if (name.length > 120) {
    return invalid("Event name is capped at 120 characters.", values);
  }

  const slug = normalizeSlug(values.slug.trim() || name);
  if (!slug) return invalid("Slug is required.", values);

  const startsOn = fromDateInput(values.startsOn);
  const endsOn = fromDateInput(values.endsOn);
  if (startsOn && endsOn && endsOn < startsOn) {
    return invalid("End date cannot be before the start date.", values);
  }

  /*
   * A typo here used to reach the PUBLIC HOME LOADER, which formats every
   * listed event's dates in its own zone — so "Pacific" instead of
   * "America/Los_Angeles" threw `RangeError` inside `/` and served the root
   * ErrorBoundary to every visitor. Blank is fine (it takes the default); a
   * wrong-but-plausible string was not. Validated after the default fallback,
   * so the empty field is still the easy path.
   */
  const timezone = values.timezone.trim() || DEFAULT_TIMEZONE;
  if (!isValidTimeZone(timezone)) return invalid(invalidTimeZoneMessage(timezone), values);

  const db = getDb();
  const clash = await db.query.events.findFirst({ where: eq(events.slug, slug) });
  if (clash) {
    return invalid(`Another event already uses "${slug}".`, values);
  }

  await db.insert(events).values({
    name,
    slug,
    location: values.location.trim() || null,
    startsOn,
    endsOn,
    timezone,
  });

  return redirect("/admin", {
    headers: {
      "set-cookie": serializeEventCookie(slug, { secure: eventCookieSecure(request) }),
    },
  });
}

export default function AdminNewEvent({ loaderData, actionData }: Route.ComponentProps) {
  const values = actionData?.values;

  return (
    <div className="max-w-xl space-y-4">
      <h2 className="text-xl font-semibold">New event</h2>
      {/*
        A plain `<form method="post">`, not React Router's `<Form>` — the same
        choice the event switcher makes, and for the same reason.

        This action mints the `cb_admin_event` selection cookie. On a native
        document POST the browser follows the 302 itself, stores the cookie, and
        only THEN asks the layout which event is current. Submitted through the
        client router instead, parent-loader revalidation races the cookie and
        visibly lands the organizer back in the old event, having just created a
        new one. That is not a theory: the Playwright journey caught exactly
        that failure, and this is the line that fixed it.
      */}
      <form method="post" className="space-y-4" data-testid="admin-new-event-form">
        {actionData?.error ? <p className="text-sm text-red-600">{actionData.error}</p> : null}

        <div>
          <label htmlFor="name" className="block text-sm font-medium">
            Event name
          </label>
          <input
            id="name"
            name="name"
            required
            maxLength={120}
            defaultValue={values?.name ?? ""}
            className={inputClass}
          />
        </div>

        <div>
          <label htmlFor="slug" className="block text-sm font-medium">
            Slug
          </label>
          <input
            id="slug"
            name="slug"
            defaultValue={values?.slug ?? ""}
            className={inputClass}
          />
          <p className="mt-1 text-xs text-gray-500">Leave blank to generate it from the name.</p>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label htmlFor="startsOn" className="block text-sm font-medium">
              Starts
            </label>
            <input
              id="startsOn"
              name="startsOn"
              type="date"
              defaultValue={values?.startsOn ?? ""}
              className={inputClass}
            />
          </div>
          <div>
            <label htmlFor="endsOn" className="block text-sm font-medium">
              Ends
            </label>
            <input
              id="endsOn"
              name="endsOn"
              type="date"
              defaultValue={values?.endsOn ?? ""}
              className={inputClass}
            />
          </div>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label htmlFor="timezone" className="block text-sm font-medium">
              Timezone
            </label>
            <input
              id="timezone"
              name="timezone"
              defaultValue={values?.timezone ?? loaderData.defaultTimezone}
              className={inputClass}
            />
          </div>
          <div>
            <label htmlFor="location" className="block text-sm font-medium">
              Location
            </label>
            <input
              id="location"
              name="location"
              defaultValue={values?.location ?? ""}
              className={inputClass}
            />
          </div>
        </div>

        {/*
          `buttonClass("primary")`, not a hand-rolled fill. Rungs 3.1 and 3.C
          converted the product's fifteen raw black primaries to this one
          helper precisely so a black button could not reappear next to a blue
          one — in dark mode that fill inverts to near-white, which makes the
          button the brightest object on the page. #91 merged after #88 and
          reintroduced the last one, and nothing enforces the invariant, so the
          gates stayed green on a visible regression. The accessible name is
          unchanged: `event-create.spec.ts:49` clicks `Create event`, exact.
        */}
        <button type="submit" className={buttonClass("primary")}>
          Create event
        </button>
      </form>
    </div>
  );
}
