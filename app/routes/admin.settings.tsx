import { and, eq, ne } from "drizzle-orm";
import { Form } from "react-router";

import { EmbedGrabCard } from "~/components/embed-grab";
import { buttonClass } from "~/components/portal-ui";
import { getDb } from "~/db/client.server";
import { events } from "~/db/schema";
import { requireAdmin } from "~/lib/auth/auth.server";
import {
  fromDateInput,
  invalidTimeZoneMessage,
  isValidTimeZone,
  normalizeSlug,
  toDateInput,
} from "~/lib/event-form";
import { requireCurrentEvent } from "~/lib/event.server";
import type { Route } from "./+types/admin.settings";

export function meta() {
  return [{ title: "Settings — callboard admin" }];
}

export async function loader({ request }: Route.LoaderArgs) {
  await requireAdmin(request);
  const event = await requireCurrentEvent(request);
  const origin = new URL(request.url).origin;

  return {
    event: {
      id: event.id,
      name: event.name,
      slug: event.slug,
      location: event.location ?? "",
      timezone: event.timezone,
      description: event.description ?? "",
      startsOn: toDateInput(event.startsOn),
      endsOn: toDateInput(event.endsOn),
      submissionLimit: event.submissionLimit ?? "",
    },
    submitUrlPrefix: `${origin}/submit/${event.slug}/`,
  };
}

export async function action({ request }: Route.ActionArgs) {
  await requireAdmin(request);
  const event = await requireCurrentEvent(request);
  const db = getDb();
  const formData = await request.formData();

  const name = String(formData.get("name") ?? "").trim();
  const slug = normalizeSlug(String(formData.get("slug") ?? ""));
  const submissionLimitRaw = String(formData.get("submissionLimit") ?? "").trim();

  if (!name) return { ok: false as const, error: "Name is required." };
  if (!slug) return { ok: false as const, error: "Slug is required." };

  const clash = await db.query.events.findFirst({
    where: and(eq(events.slug, slug), ne(events.id, event.id)),
  });
  if (clash) return { ok: false as const, error: `Another event already uses "${slug}".` };

  const submissionLimit = submissionLimitRaw ? Number(submissionLimitRaw) : null;
  if (submissionLimit !== null && (!Number.isInteger(submissionLimit) || submissionLimit < 1)) {
    return { ok: false as const, error: "Submission limit must be a whole number ≥ 1." };
  }

  // The other door onto `events.timezone`. Same check as `/admin/events/new`,
  // for the same reason: an unknown zone reaches `Intl` in the public home
  // loader and 500s the front page. See `formatDateRange` in `~/lib/dates`.
  const timezone = String(formData.get("timezone") ?? "").trim() || "America/Los_Angeles";
  if (!isValidTimeZone(timezone)) {
    return { ok: false as const, error: invalidTimeZoneMessage(timezone) };
  }

  await db
    .update(events)
    .set({
      name,
      slug,
      description: String(formData.get("description") ?? "").trim() || null,
      location: String(formData.get("location") ?? "").trim() || null,
      timezone,
      startsOn: fromDateInput(String(formData.get("startsOn") ?? "")),
      endsOn: fromDateInput(String(formData.get("endsOn") ?? "")),
      submissionLimit,
      updatedAt: new Date(),
    })
    .where(eq(events.id, event.id));

  return { ok: true as const, error: null };
}

const FIELD_CLASS =
  "w-full rounded border border-gray-300 px-3 py-2 dark:border-gray-700 dark:bg-gray-900";

export default function AdminSettings({ loaderData, actionData }: Route.ComponentProps) {
  const { event, submitUrlPrefix } = loaderData;

  return (
    <Form method="post" className="max-w-xl space-y-4">
      {actionData?.ok ? (
        <p className="rounded border border-green-300 bg-green-50 p-3 text-sm dark:border-green-800 dark:bg-green-950">
          Saved.
        </p>
      ) : null}
      {actionData?.error ? (
        <p className="text-sm text-red-600">{actionData.error}</p>
      ) : null}

      <EmbedGrabCard />

      <div>
        <label htmlFor="name" className="mb-1 block text-sm font-medium">
          Event name
        </label>
        <input id="name" name="name" defaultValue={event.name} className={FIELD_CLASS} />
      </div>

      <div>
        <label htmlFor="slug" className="mb-1 block text-sm font-medium">
          Slug
        </label>
        <input id="slug" name="slug" defaultValue={event.slug} className={FIELD_CLASS} />
        <p className="mt-1 text-xs text-gray-500">
          Drives the public CFP URL:{" "}
          <code className="font-mono break-all">{submitUrlPrefix}&lt;form-id&gt;</code>
        </p>
      </div>

      <div>
        <label htmlFor="description" className="mb-1 block text-sm font-medium">
          Description
        </label>
        <textarea
          id="description"
          name="description"
          rows={3}
          defaultValue={event.description}
          className={FIELD_CLASS}
        />
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label htmlFor="startsOn" className="mb-1 block text-sm font-medium">
            Starts
          </label>
          <input
            id="startsOn"
            name="startsOn"
            type="date"
            defaultValue={event.startsOn}
            className={FIELD_CLASS}
          />
        </div>
        <div>
          <label htmlFor="endsOn" className="mb-1 block text-sm font-medium">
            Ends
          </label>
          <input
            id="endsOn"
            name="endsOn"
            type="date"
            defaultValue={event.endsOn}
            className={FIELD_CLASS}
          />
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label htmlFor="timezone" className="mb-1 block text-sm font-medium">
            Timezone
          </label>
          <input
            id="timezone"
            name="timezone"
            defaultValue={event.timezone}
            className={FIELD_CLASS}
          />
        </div>
        <div>
          <label htmlFor="location" className="mb-1 block text-sm font-medium">
            Location
          </label>
          <input
            id="location"
            name="location"
            defaultValue={event.location}
            className={FIELD_CLASS}
          />
        </div>
      </div>

      <div>
        <label htmlFor="submissionLimit" className="mb-1 block text-sm font-medium">
          Submission limit per person
        </label>
        <input
          id="submissionLimit"
          name="submissionLimit"
          type="number"
          min={1}
          defaultValue={event.submissionLimit}
          className={FIELD_CLASS}
        />
        <p className="mt-1 text-xs text-gray-500">
          Event-level default. A form may override it. Blank = unlimited.
        </p>
      </div>

      <button type="submit" className={buttonClass("primary")}>
        Save settings
      </button>
    </Form>
  );
}
