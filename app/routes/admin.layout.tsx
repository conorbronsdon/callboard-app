import { Link, Outlet, useLocation } from "react-router";

import { buttonClass } from "~/components/portal-ui";
import { eyebrowClass, linkClass, Shell, SignOutButton } from "~/components/shell";
import { requireAdmin } from "~/lib/auth/auth.server";
import { currentEvent, listEvents } from "~/lib/event.server";
import type { Route } from "./+types/admin.layout";

/**
 * Admin guard for every `/admin/*` route. Nested loaders run in parallel with
 * this one, so they must not assume it has already passed — anything that reads
 * privileged data calls `requireAdmin` itself.
 */
export async function loader({ request }: Route.LoaderArgs) {
  const person = await requireAdmin(request);
  const [event, options] = await Promise.all([currentEvent(request), listEvents()]);
  return {
    person: { email: person.email, fullName: person.fullName },
    event: event ? { name: event.name, slug: event.slug } : null,
    events: options.map((option) => ({ name: option.name, slug: option.slug })),
  };
}

/**
 * The persistent event switcher.
 *
 * Renders NOTHING below two events, so the single-event demo — and every
 * existing Playwright journey that assumes it — is untouched. It lives here in
 * the admin layout rather than in `components/shell.tsx` because the shell is
 * shared with the public, portal and reviewer surfaces, which must never offer
 * an event switcher.
 *
 * A plain `<form method="post">` — not React Router's `<Form>` — with a
 * labelled `<select>` and a submit button: keyboard-operable, functional with
 * no client JS, and renderable outside a router so the suite can assert on it
 * directly (the same reason `ReviewerPreviewTable` uses a plain form).
 */
export function EventSwitcher({
  events,
  currentSlug,
  redirectTo,
}: {
  events: { name: string; slug: string }[];
  currentSlug: string | null;
  redirectTo: string;
}) {
  if (events.length < 2) return null;

  return (
    <form
      method="post"
      action="/admin/event"
      data-testid="admin-event-switcher"
      data-current-event={currentSlug ?? ""}
      className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm"
    >
      <input type="hidden" name="redirectTo" value={redirectTo} />
      <label
        htmlFor="admin-event-select"
        className={eyebrowClass}
      >
        Event
      </label>
      <select
        id="admin-event-select"
        name="event"
        defaultValue={currentSlug ?? events[0].slug}
        className="min-w-0 max-w-full rounded-lg border border-gray-300 bg-white px-2.5 py-1.5 text-sm text-gray-900 dark:border-gray-700 dark:bg-gray-950 dark:text-gray-100"
      >
        {events.map((event) => (
          <option key={event.slug} value={event.slug}>
            {event.name}
          </option>
        ))}
      </select>
      <button type="submit" className={buttonClass("secondary")}>
        Switch event
      </button>
    </form>
  );
}

export default function AdminLayout({ loaderData }: Route.ComponentProps) {
  const location = useLocation();

  /*
   * `/review` is the ONE nav destination outside `/admin`, so it is the one
   * that cannot inherit the event selection: the cookie is `Path=/admin` and
   * `currentEvent` refuses to read it off a non-admin path anyway. It therefore
   * carries the slug explicitly, the same way `ReviewerPreviewTable`'s form
   * does — without it, an organizer on the second event would land in whichever
   * event `requireReviewerEvent` resolves oldest-first, silently.
   *
   * Every other entry stays a bare path on purpose: those ride the cookie, and
   * a query param on them would outrank a later switch (see `safeAdminRedirect`).
   */
  const reviewerWorkspace = loaderData.event
    ? `/review?event=${encodeURIComponent(loaderData.event.slug)}`
    : "/review";

  return (
    <Shell
      title="Admin"
      subtitle={loaderData.event?.name ?? "No event set up yet"}
      nav={[
        { to: "/admin", label: "Dashboard", end: true },
        { to: "/admin/forms", label: "Forms" },
        { to: "/admin/submissions", label: "Submissions" },
        { to: "/admin/reviews", label: "Review ops" },
        { to: reviewerWorkspace, label: "Reviewer workspace" },
        { to: "/admin/resources", label: "Resources" },
        { to: "/admin/agenda", label: "Agenda" },
        { to: "/admin/embeds", label: "Embeds" },
        { to: "/admin/contacts", label: "Contacts" },
        { to: "/admin/pipeline", label: "Pipeline" },
        { to: "/admin/speakers", label: "Speakers" },
        { to: "/admin/tasks", label: "Tasks" },
        { to: "/admin/files", label: "Files" },
        { to: "/admin/view-as", label: "View as" },
        { to: "/admin/templates", label: "Templates" },
        { to: "/admin/comms", label: "Comms" },
        { to: "/admin/settings", label: "Settings" },
        { to: "/admin/integrations", label: "Integrations" },
        { to: "/admin/api-keys", label: "API keys" },
        { to: "/admin/jobs", label: "Jobs" },
      ]}
      actions={
        <>
          <span className="hidden text-gray-600 sm:inline dark:text-gray-400">
            {loaderData.person.email}
          </span>
          <SignOutButton />
        </>
      }
    >
      {/*
       * Chrome, not content. Loose on the page ground this row read as the
       * screen's first control — an unlabelled `<select>` and two buttons
       * floating above the actual page title, and at 375px it broke into three
       * ragged lines. Inside a bordered strip it reads as what it is: the
       * workspace scope selector that sits above every organizer screen.
       */}
      <div className="mb-5 flex flex-wrap items-center justify-between gap-x-4 gap-y-2 rounded-xl border border-gray-200 bg-white px-3 py-2 shadow-card dark:border-gray-800 dark:bg-gray-900">
        <EventSwitcher
          events={loaderData.events}
          currentSlug={loaderData.event?.slug ?? null}
          redirectTo={`${location.pathname}${location.search}`}
        />
        <Link
          className={`${linkClass} text-sm`}
          data-testid="admin-new-event"
          to="/admin/events/new"
        >
          New event
        </Link>
      </div>
      <Outlet />
    </Shell>
  );
}
