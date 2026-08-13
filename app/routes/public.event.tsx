/**
 * The public face of an event — and, for a lot of people, the first callboard
 * page they ever see.
 *
 * It used to render the name, the location and a bulleted list of open-call
 * links on empty white: nothing about when the event runs, when the call
 * closes, how big the programme is, or what to do next. Everything below is
 * already in the database; the page just never asked for it.
 */
import { and, asc, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { Link } from "react-router";

import { buttonClass, StatusPill } from "~/components/portal-ui";
import { eyebrowClass, LaneStub, linkClass, Shell } from "~/components/shell";
import { getDb } from "~/db/client.server";
import { events, forms, sessions } from "~/db/schema";
import { formatDateRange } from "~/lib/dates";
import type { Route } from "./+types/public.event";

export function meta({ loaderData }: Route.MetaArgs) {
  return [{ title: loaderData ? `${loaderData.event.name} — callboard` : "callboard" }];
}

/** "Sep 15, 11:59 PM PDT" — a deadline, so the time and zone are the point. */
function formatDeadline(closesAt: Date | null, timeZone: string): string | null {
  if (!closesAt) return null;
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(closesAt);
}

export async function loader({ params }: Route.LoaderArgs) {
  const db = getDb();
  const event = await db.query.events.findFirst({ where: eq(events.slug, params.slug) });
  if (!event) throw new Response("Event not found", { status: 404 });

  const [openForms, publishedRows] = await Promise.all([
    db.query.forms.findMany({
      where: and(eq(forms.eventId, event.id), eq(forms.surface, "cfp")),
      orderBy: asc(forms.createdAt),
    }),
    /*
     * The same predicate the schedule page uses, so both describe the same set
     * of sessions. It is the true total, not the number of rows the schedule
     * draws: that query caps at `.limit(500)` (public.schedule.tsx), so beyond
     * 500 published sessions this count is the larger of the two by design.
     * Unreachable for any real programme — but the earlier version of this
     * comment claimed the two "can never disagree", which was not true of the
     * code beneath it. One aggregate — no bind-parameter growth as the
     * programme fills up.
     */
    db
      .select({ n: sql<number>`count(*)` })
      .from(sessions)
      .where(
        and(
          eq(sessions.eventId, event.id),
          eq(sessions.isAbstract, false),
          eq(sessions.isPublic, true),
          isNotNull(sessions.startsAt),
          isNull(sessions.deletedAt),
        ),
      ),
  ]);

  const timeZone = event.timezone;
  return {
    event: {
      name: event.name,
      slug: event.slug,
      location: event.location,
      description: event.description,
      dateRange: formatDateRange(event.startsOn, event.endsOn, timeZone),
    },
    publishedSessions: Number(publishedRows[0]?.n ?? 0),
    forms: openForms
      .filter((form) => form.status === "open")
      .map((form) => ({
        id: form.id,
        name: form.name,
        target: form.target,
        closesLabel: formatDeadline(form.closesAt, timeZone),
      })),
  };
}

export default function PublicEvent({ loaderData }: Route.ComponentProps) {
  const { event, forms: openForms, publishedSessions } = loaderData;

  /* Dates · location · programme size — only the facts that exist. */
  const facts = [
    event.dateRange,
    event.location,
    publishedSessions > 0
      ? `${publishedSessions} session${publishedSessions === 1 ? "" : "s"}`
      : null,
  ].filter((fact): fact is string => Boolean(fact));

  return (
    <Shell
      title={event.name}
      titleSize="display"
      nav={[
        { to: `/e/${event.slug}`, label: "Overview", end: true },
        { to: `/e/${event.slug}/schedule`, label: "Schedule" },
        { to: `/e/${event.slug}/speakers`, label: "Speakers" },
      ]}
    >
      <div className="space-y-6">
        <section className="rounded-2xl border border-gray-200 bg-white p-5 shadow-card sm:p-6 dark:border-gray-800 dark:bg-gray-900">
          {facts.length > 0 ? (
            <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-gray-600 dark:text-gray-400">
              {facts.map((fact, index) => (
                <span key={fact} className="flex items-center gap-x-2">
                  {index > 0 ? (
                    <span aria-hidden="true" className="text-gray-300 dark:text-gray-700">
                      ·
                    </span>
                  ) : null}
                  {fact}
                </span>
              ))}
            </p>
          ) : null}
          {event.description ? (
            <p className="mt-3 max-w-prose text-sm leading-6 text-gray-600 dark:text-gray-300">
              {event.description}
            </p>
          ) : null}
          {publishedSessions > 0 ? (
            <p className="mt-4">
              <Link className={buttonClass("secondary")} to={`/e/${event.slug}/schedule`}>
                View the schedule
              </Link>
            </p>
          ) : null}
        </section>

        <section className="space-y-3">
          {/* Eyebrow + heading, the section-header pattern the /demo page and
              the public home already use. The eyebrow names the surface; the
              heading says what is on it right now. */}
          <div>
            <p className={eyebrowClass}>Call for proposals</p>
            <h2 className="mt-0.5 text-lg font-semibold tracking-tight">Open calls</h2>
          </div>
          {openForms.length === 0 ? (
            <LaneStub lane="Nothing open right now">
              {event.name} is not accepting submissions at the moment. Check back — open calls
              appear here as soon as they launch.{" "}
              {publishedSessions > 0 ? (
                <Link className={linkClass} to={`/e/${event.slug}/schedule`}>
                  See what is already programmed
                </Link>
              ) : null}
            </LaneStub>
          ) : (
            <ul className="grid gap-4 sm:grid-cols-2">
              {openForms.map((form) => {
                /*
                 * The visible label names the target type, not the call. Two
                 * open calls with the same target therefore render two links
                 * with the same accessible name pointing at different forms —
                 * WCAG 2.4.4, and indistinguishable in a screen reader's link
                 * list, which does not carry the surrounding card text. The
                 * aria-label adds the call's own name; the visible text stays
                 * the short imperative, and stays the start of the accessible
                 * name so "click Submit an abstract" still matches.
                 */
                const cta =
                  form.target === "submission" ? "Submit an abstract" : "Propose a session";
                return (
                  <li
                    key={form.id}
                    className="flex h-full flex-col rounded-xl border border-gray-200 bg-white p-4 shadow-card transition hover:border-blue-300 sm:p-5 dark:border-gray-800 dark:bg-gray-900 dark:hover:border-blue-800"
                  >
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <p className="font-medium">{form.name}</p>
                      <StatusPill tone="positive">Open</StatusPill>
                    </div>
                    {/* The stored target is `submission` / `session` — database
                        vocabulary. A submitter reads what they are about to send. */}
                    <p className="mt-1 grow text-sm text-gray-600 dark:text-gray-400">
                      {form.target === "submission"
                        ? "Send an abstract for the programme team to review."
                        : "Propose a session for a guaranteed slot on the agenda."}
                      {form.closesLabel ? ` Closes ${form.closesLabel}.` : ""}
                    </p>
                    <p className="mt-4">
                      <Link
                        aria-label={`${cta} — ${form.name}`}
                        className={buttonClass("primary")}
                        to={`/submit/${event.slug}/${form.id}`}
                      >
                        {cta}
                      </Link>
                    </p>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </div>
    </Shell>
  );
}
