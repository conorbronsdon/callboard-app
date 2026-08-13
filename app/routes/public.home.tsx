import { and, asc, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { Link } from "react-router";

import { StatusPill } from "~/components/portal-ui";
import { eyebrowClass, linkClass, Shell, SignOutButton } from "~/components/shell";
import { getDb } from "~/db/client.server";
/** Aliased: the loader destructures its own `events` from the query results. */
import { events as eventsTable, forms, sessions } from "~/db/schema";
import { getCurrentPerson } from "~/lib/auth/auth.server";
import { formatDateRange } from "~/lib/dates";
import { isDemoMode } from "~/lib/env.server";
import type { Route } from "./+types/public.home";

export function meta(_: Route.MetaArgs) {
  return [
    { title: "callboard" },
    {
      name: "description",
      content: "Open-source speaker & CFP management: forms, review, portal, agenda.",
    },
  ];
}

/**
 * THE ONE LOADER CHANGE in rung 3.
 *
 * `findMany` already returns the whole row — the old mapper simply threw away
 * `startsOn`, `endsOn` and `timezone` before the component could use them, so
 * dates cost nothing extra to show.
 *
 * The open-call count is ONE aggregate across every listed event, grouped by
 * event id. Not a per-event query in a loop: a fan-out would add a statement
 * (and a bind parameter) for every event that ever gets created, on the page
 * behind the wordmark on every screen in the product.
 */
/**
 * The public-schedule predicate, restated as an aggregate.
 *
 * `loadPublicSchedule` owns the query the widget renders; this counts the same
 * rows so the home page can know whether the widget it is about to frame has
 * anything in it. Kept as ONE grouped aggregate for the same reason
 * `openCalls` is — a per-event query in a loop on the page behind the wordmark
 * grows a statement for every event that ever gets created.
 */
const publishedSessionsByEvent = () =>
  getDb()
    .select({ eventId: sessions.eventId, n: sql<number>`count(*)` })
    .from(sessions)
    .where(
      and(
        eq(sessions.isAbstract, false),
        eq(sessions.isPublic, true),
        isNotNull(sessions.startsAt),
        isNull(sessions.deletedAt),
      ),
    )
    .groupBy(sessions.eventId);

export async function loader({ request }: Route.LoaderArgs) {
  const db = getDb();
  const [events, openCalls, publishedSessions, person] = await Promise.all([
    /*
     * Oldest first, which is what `listEvents()` and `currentEvent()`'s default
     * already mean by "the" event. It was the de-facto order anyway (insertion
     * order); saying so is what lets the embed below pick the same primary
     * event the admin chrome would, and stops a 21st event from hiding it.
     */
    db.query.events.findMany({ limit: 20, orderBy: [asc(eventsTable.createdAt)] }),
    db
      .select({ eventId: forms.eventId, n: sql<number>`count(*)` })
      .from(forms)
      .where(and(eq(forms.surface, "cfp"), eq(forms.status, "open")))
      .groupBy(forms.eventId),
    publishedSessionsByEvent(),
    getCurrentPerson(request),
  ]);

  const openByEvent = new Map(openCalls.map((row) => [row.eventId, Number(row.n)]));
  const publishedByEvent = new Map(
    publishedSessions.map((row) => [row.eventId, Number(row.n)]),
  );

  /*
   * The self-proving embed. `theme=auto` is spelled out rather than omitted:
   * the parameter IS the demonstration, and `auto` is what makes the widget
   * follow the visitor's colour scheme exactly as this page does.
   *
   * `null` when the primary event has nothing published — a widget rendering
   * its own empty state inside an iframe on the front page is worse evidence
   * than no iframe at all.
   */
  const primary = events[0];
  const publishedCount = primary ? (publishedByEvent.get(primary.id) ?? 0) : 0;
  const embed =
    primary && publishedCount > 0
      ? {
          name: primary.name,
          src: `/embed/${encodeURIComponent(primary.slug)}/agenda?theme=auto`,
        }
      : null;

  return {
    events: events.map((event) => ({
      id: event.id,
      name: event.name,
      slug: event.slug,
      location: event.location,
      dates: formatDateRange(event.startsOn, event.endsOn, event.timezone),
      openCalls: openByEvent.get(event.id) ?? 0,
    })),
    embed,
    person: person ? { email: person.email, role: person.role } : null,
    demoMode: isDemoMode(),
  };
}

/**
 * The embed area, proved rather than described.
 *
 * Every other page in the product can only CLAIM the widgets work. This frames
 * the real `/embed/<slug>/agenda` route — the same URL the organizer's
 * copy-paste snippet points at, served by the same loader, under the same
 * `frame-ancestors *` exception — so the section is the evidence.
 *
 * `loading="lazy"`: it sits below the events list, so a visitor who never
 * scrolls never pays for it.
 */
function LiveEmbedProof({ embed }: { embed: { name: string; src: string } }) {
  return (
    <section
      data-testid="home-embed-proof"
      className="mt-10 rounded-xl border border-gray-200 bg-white p-5 shadow-card dark:border-gray-800 dark:bg-gray-900"
    >
      <p className={eyebrowClass}>Embeddable widgets</p>
      <h2 className="mt-1 text-lg font-semibold tracking-tight">This is the live embed</h2>
      <p className="mt-1 max-w-prose text-sm text-gray-600 dark:text-gray-400">
        This is the live embed — the same server-rendered agenda widget an organizer pastes
        into their own site. Below is {embed.name}, in an iframe pointed at the widget URL
        the organizer copies, following this page's colour scheme.
      </p>
      <iframe
        data-testid="home-embed-iframe"
        src={embed.src}
        title={`${embed.name} — agenda`}
        loading="lazy"
        height="720"
        className="mt-4 block w-full rounded-lg border border-gray-200 dark:border-gray-800"
      />
      <p className="mt-3 text-sm">
        <a className={linkClass} href={embed.src}>
          Open the widget on its own
        </a>
      </p>
    </section>
  );
}

export default function PublicHome({ loaderData }: Route.ComponentProps) {
  const { events, embed, person, demoMode } = loaderData;

  return (
    <Shell
      title="Events"
      titleSize="display"
      subtitle="Open-source speaker and CFP management."
      actions={
        person ? (
          <>
            <span className="text-gray-600 dark:text-gray-400">{person.email}</span>
            <Link className={linkClass} to={person.role === "admin" ? "/admin" : "/portal"}>
              {person.role === "admin" ? "Admin" : "Portal"}
            </Link>
            <SignOutButton />
          </>
        ) : (
          <>
            {demoMode ? (
              <Link className={linkClass} to="/demo">
                Demo
              </Link>
            ) : null}
            <Link className={linkClass} to="/login">
              Sign in
            </Link>
          </>
        )
      }
    >
      {events.length === 0 ? (
        <div className="rounded-xl border border-dashed border-gray-300 bg-white/60 p-8 text-center dark:border-gray-700 dark:bg-gray-900/40">
          <p className="text-base font-semibold">No events yet</p>
          <p className="mx-auto mt-2 max-w-md text-sm leading-6 text-gray-600 dark:text-gray-400">
            Create an event in the organizer workspace and it appears here with its
            schedule, its speakers and every call still taking submissions.
          </p>
        </div>
      ) : (
        <>
          {/*
           * A real section head, and a wider measure for its one sentence. At
           * 1440 the old block set an eyebrow and a `max-w-prose` line inside an
           * 1104px column, which broke the sentence across two ragged lines
           * against nothing — a stray paragraph on the front door of the
           * product, above two small cards and 500px of empty ground.
           */}
          <div className="mb-5 border-b border-gray-200 pb-5 dark:border-gray-800">
            <p className={eyebrowClass}>Public events</p>
            <h2 className="mt-1.5 text-2xl font-semibold tracking-tight">
              {events.length} event{events.length === 1 ? "" : "s"} on this callboard
            </h2>
            <p className="mt-1.5 max-w-2xl text-sm leading-6 text-gray-600 dark:text-gray-400">
              Open one for its schedule, its speakers and any call still taking
              submissions.
            </p>
          </div>
          {/*
           * Two events stay two-up; the third desktop track appears only when
           * there are enough cards to fill it. A one-event board stays one-up.
           *
           * `shadow-card` rests rather than arriving on hover. This card was
           * the ONLY `hover:shadow-card` in the product — every other lifted
           * card (public event, schedule row, demo role card) rests lifted —
           * and a card that becomes an object only while a pointer is over it
           * is a card that never becomes one on a touch screen.
           */}
          <ul
            className={`grid gap-4${events.length >= 2 ? " sm:grid-cols-2" : ""}${
              events.length >= 3 ? " lg:grid-cols-3" : ""
            }`}
          >
            {events.map((event) => (
              <li
                key={event.id}
                /*
                 * `flex flex-col` with a pinned footer. Three short lines in a
                 * stretched grid cell left every card ragged at the bottom, and
                 * a card that is only a headline and a date is not an object a
                 * visitor believes they can open — so the two destinations
                 * behind it are now on its face.
                 */
                className="flex h-full flex-col rounded-xl border border-gray-200 bg-white p-5 shadow-card transition hover:border-blue-300 dark:border-gray-800 dark:bg-gray-900 dark:hover:border-blue-800"
              >
                <Link
                  className="text-xl font-semibold tracking-tight text-balance text-gray-900 underline-offset-4 hover:text-blue-700 hover:underline dark:text-gray-100 dark:hover:text-blue-300"
                  to={`/e/${event.slug}`}
                >
                  {event.name}
                </Link>
                {event.dates || event.location ? (
                  <p className="mt-1.5 text-sm text-gray-600 dark:text-gray-400">
                    {[event.dates, event.location].filter(Boolean).join(" · ")}
                  </p>
                ) : null}
                {/*
                 * The count was already in the loader — one grouped aggregate,
                 * paid for — and the card threw it away, so two events with one
                 * open call and with five read identically. It is the one fact
                 * on this page a speaker is shopping for.
                 */}
                {event.openCalls > 0 ? (
                  <p className="mt-3 flex flex-wrap items-center gap-2">
                    <StatusPill tone="positive">CFP open</StatusPill>
                    <span
                      data-open-calls={event.openCalls}
                      className={`${eyebrowClass} tabular-nums`}
                    >
                      {event.openCalls} open call{event.openCalls === 1 ? "" : "s"}
                    </span>
                  </p>
                ) : null}
                <p className="mt-auto flex flex-wrap gap-x-4 gap-y-1 border-t border-gray-100 pt-4 text-sm dark:border-gray-800">
                  <Link className={linkClass} to={`/e/${event.slug}/schedule`}>
                    Schedule
                  </Link>
                  <Link className={linkClass} to={`/e/${event.slug}/speakers`}>
                    Speakers
                  </Link>
                </p>
              </li>
            ))}
          </ul>
        </>
      )}
      {embed ? <LiveEmbedProof embed={embed} /> : null}
    </Shell>
  );
}
