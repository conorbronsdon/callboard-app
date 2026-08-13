/** Public, progressively enhanced schedule and personal itinerary. */
import { useEffect, useMemo, useState } from "react";
import type { ChangeEvent, FormEvent } from "react";
import { Link } from "react-router";

import { useHydrated } from "~/components/ClientOnly";
import { buttonClass, inputClass } from "~/components/portal-ui";
import { PublicSlotChips, PublicSpeakerList } from "~/components/schedule-list";
import { Shell, linkClass } from "~/components/shell";
import { loadPublicSchedule } from "~/lib/agenda/public-schedule.server";
import {
  EMPTY_FILTER,
  countSessions,
  filterDays,
  parseScheduleFilter,
  parseStoredSchedule,
  pruneStoredSchedule,
  scheduleFilterQuery,
  serialiseStoredSchedule,
  type ScheduleFilter,
} from "~/lib/agenda/public-schedule";
import type { Route } from "./+types/public.schedule";

/*
 * Re-exported, not redefined: `public.session.tsx` imports these two from this
 * module and the suite asserts on their markup. They now live in
 * `~/components/schedule-list` so the embed widget can render sessions through
 * exactly the same leaves without importing a route module.
 */
export { PublicSlotChips, PublicSpeakerList };

export function meta({ loaderData }: Route.MetaArgs) {
  return [{ title: loaderData ? `Schedule — ${loaderData.event.name}` : "Schedule" }];
}

export async function loader({ params, request }: Route.LoaderArgs) {
  return {
    ...(await loadPublicSchedule(params.slug)),
    initialFilter: parseScheduleFilter(new URL(request.url).searchParams),
  };
}

function hrefForDay(filter: ScheduleFilter, day: string): string {
  return `?${scheduleFilterQuery({ ...filter, day })}`;
}

export default function PublicSchedule({ loaderData }: Route.ComponentProps) {
  const { event, days, total, facets, initialFilter } = loaderData;
  const hydrated = useHydrated();
  const [filter, setFilter] = useState<ScheduleFilter>(initialFilter);
  const [starredIds, setStarredIds] = useState<Set<string>>(() => new Set());
  const [storageLoaded, setStorageLoaded] = useState(false);
  const [mine, setMine] = useState(false);
  const validIds = useMemo(
    () => new Set(days.flatMap((day) => day.sessions.map((slot) => slot.id))),
    [days],
  );
  const storageKey = `callboard:my-schedule:v1:${event.slug}`;

  useEffect(() => {
    try {
      const restored = parseStoredSchedule(window.localStorage.getItem(storageKey));
      setStarredIds(new Set(pruneStoredSchedule(restored, validIds)));
    } catch {
      setStarredIds(new Set());
    } finally {
      setStorageLoaded(true);
    }
  }, [storageKey, validIds]);

  useEffect(() => {
    // Do not write until the first read lands: an eager empty write erases a
    // visitor's saved itinerary on every full page load.
    if (!storageLoaded) return;
    try {
      window.localStorage.setItem(storageKey, serialiseStoredSchedule(starredIds));
    } catch {
      // Storage can be unavailable; the in-memory itinerary still works.
    }
  }, [starredIds, storageKey, storageLoaded]);

  const visibleDays = filterDays(days, filter, mine ? starredIds : null);
  const visibleCount = countSessions(visibleDays);
  const activeDay = filter.day ? days.find((day) => day.day === filter.day) : null;
  const activeDayLabel = filter.day
    ? activeDay?.label ?? "Selected day unavailable"
    : "All days";
  const exportIds = [...starredIds].filter((id) => validIds.has(id));
  const exportHref = `/e/${event.slug}/schedule.ics?s=${encodeURIComponent(exportIds.join(","))}`;

  const updateField =
    (key: keyof ScheduleFilter) =>
    (event: ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
      setFilter((current) => ({ ...current, [key]: event.target.value }));
    };
  /*
   * Reset has to clear BOTH halves, and it is the only control that does.
   *
   * Live filtering deliberately never writes to the URL, so the filter lives in
   * two places at once: this state, and whatever query string the visitor
   * arrived on. Clearing only the state leaves a stale `?q=…&day=…` that the
   * next reload or shared link silently restores. Clearing only the URL — by
   * letting the link navigate on its own — does nothing visible, because a
   * same-route navigation re-runs the loader WITHOUT remounting the component,
   * so the `useState(initialFilter)` initialiser never fires a second time.
   * (The Back control from a session detail crosses a route boundary, remounts,
   * and therefore does pick its filter up from the URL.)
   *
   * So: no `preventDefault` — the navigation proceeds and cleans the URL — plus
   * an explicit state clear for the render that is already on screen.
   */
  const reset = () => {
    setFilter(EMPTY_FILTER);
    setMine(false);
  };

  return (
    <Shell
      title={`${event.name} — Schedule`}
      titleSize="display"
      nav={[
        { to: `/e/${event.slug}`, label: "Overview", end: true },
        { to: `/e/${event.slug}/schedule`, label: "Schedule" },
        { to: `/e/${event.slug}/speakers`, label: "Speakers" },
      ]}
    >
      {total === 0 ? (
        <div className="rounded-xl border border-dashed border-gray-300 bg-white/60 p-8 text-center dark:border-gray-700 dark:bg-gray-900/40">
          <p className="font-medium">The schedule is not published yet.</p>
          <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
            Sessions appear here once the organisers publish them. Check back soon.
          </p>
        </div>
      ) : (
        <>
          <form
            method="get"
            data-schedule-controls
            className="mb-5 rounded-xl border border-gray-200 bg-white p-4 shadow-card dark:border-gray-800 dark:bg-gray-900"
            onSubmit={(submitEvent: FormEvent<HTMLFormElement>) => {
              if (hydrated) submitEvent.preventDefault();
            }}
          >
            <label htmlFor="schedule-q" className="block text-sm font-medium">
              Search sessions and speakers
            </label>
            <input
              id="schedule-q"
              name="q"
              type="search"
              value={filter.q}
              onChange={updateField("q")}
              className={inputClass}
            />
            <input type="hidden" name="day" value={filter.day} />
            <details data-schedule-filters open className="mt-3">
              <summary className="cursor-pointer text-sm font-semibold">Filters</summary>
              <div className="mt-3 grid gap-3 sm:grid-cols-3">
                {(
                  [
                    ["track", "Track", "All tracks", facets.tracks],
                    ["format", "Format", "All formats", facets.formats],
                    ["room", "Location", "All locations", facets.rooms],
                  ] as const
                ).map(([name, label, allLabel, options]) => (
                  <label key={name} className="block text-sm font-medium">
                    {label}
                    <select
                      name={name}
                      value={filter[name]}
                      onChange={updateField(name)}
                      className={inputClass}
                    >
                      <option value="">{allLabel}</option>
                      {options.map((option) => (
                        <option key={option} value={option}>
                          {option}
                        </option>
                      ))}
                    </select>
                  </label>
                ))}
              </div>
            </details>
            <div className="mt-4 flex flex-wrap items-center gap-3">
              <button type="submit" className={buttonClass("primary")}>
                Show sessions
              </button>
              <Link className={linkClass} to={`/e/${event.slug}/schedule`} onClick={reset}>
                Reset filters
              </Link>
            </div>
          </form>

          <nav data-day-nav aria-label="Schedule days" className="mb-4 flex gap-2 overflow-x-auto pb-1">
            <a
              href={hrefForDay(filter, "")}
              data-day-tab=""
              aria-current={!filter.day ? "page" : undefined}
              className={buttonClass(!filter.day ? "primary" : "secondary", "sm")}
              onClick={(clickEvent) => {
                if (!hydrated) return;
                clickEvent.preventDefault();
                setFilter((current) => ({ ...current, day: "" }));
              }}
            >
              All days
            </a>
            {days.map((day) => (
              <a
                key={day.day}
                href={hrefForDay(filter, day.day)}
                data-day-tab={day.day}
                aria-current={filter.day === day.day ? "page" : undefined}
                className={buttonClass(filter.day === day.day ? "primary" : "secondary", "sm")}
                onClick={(clickEvent) => {
                  if (!hydrated) return;
                  clickEvent.preventDefault();
                  setFilter((current) => ({ ...current, day: day.day }));
                }}
              >
                {day.label}
              </a>
            ))}
          </nav>

          <h2 data-selected-day className="text-xl font-semibold tracking-tight">
            {activeDayLabel}
          </h2>
          {/*
           * Body text, NOT the eyebrow — tried and rejected. `event.timezone`
           * is a raw IANA id, so an uppercase eyebrow renders
           * "ALL TIMES AMERICA/LOS_ANGELES" and shouts the least important
           * half of the line. `tabular-nums` is the change worth keeping: the
           * count sits above a live filter and reflowed the sentence on every
           * keystroke as the digits changed width.
           */}
          <p
            data-result-count={visibleCount}
            className="mt-1 mb-4 text-sm tabular-nums text-gray-600 dark:text-gray-400"
          >
            {visibleCount} session{visibleCount === 1 ? "" : "s"} · all times {event.timezone}
          </p>

          {hydrated ? (
            <div className="mb-4 flex flex-wrap items-center gap-3 rounded-lg bg-blue-50 p-3 dark:bg-blue-950/50">
              <button
                type="button"
                data-my-schedule-toggle
                aria-pressed={mine}
                className={buttonClass(mine ? "primary" : "secondary")}
                onClick={() => setMine((current) => !current)}
              >
                My schedule ({starredIds.size})
              </button>
              {/*
                * Tied to the selection, not to the view: an attendee who has
                * starred sessions can export them without first switching to
                * My schedule, and the control cannot appear with nothing in it.
                */}
              {starredIds.size > 0 ? (
                <a data-my-schedule-export className={linkClass} href={exportHref}>
                  Export / add to calendar (.ics)
                </a>
              ) : null}
            </div>
          ) : null}

          {visibleDays.length === 0 ? (
            <div className="rounded-xl border border-dashed border-gray-300 bg-white/60 p-8 text-center dark:border-gray-700 dark:bg-gray-900/40">
              <p className="font-medium">No sessions match these filters.</p>
              <Link className={`${linkClass} mt-2 inline-block`} to={`/e/${event.slug}/schedule`} onClick={reset}>
                Reset filters
              </Link>
            </div>
          ) : (
            visibleDays.map((day) => (
              <section key={day.day} className="mb-8" data-schedule-day={day.day}>
                <h3 className="sticky top-0 z-10 -mx-4 mb-3 bg-gray-50/90 px-4 py-2 text-lg font-semibold backdrop-blur dark:bg-gray-950/90">
                  {day.label}
                </h3>
                <ol className="space-y-2">
                  {day.sessions.map((row) => {
                    const starred = starredIds.has(row.id);
                    const detailQuery = scheduleFilterQuery(filter);
                    const detailHref = `/e/${event.slug}/schedule/${row.id}${detailQuery ? `?${detailQuery}` : ""}`;
                    return (
                      <li
                        key={row.id}
                        id={`public-session-${row.id}`}
                        data-public-session={row.id}
                        className="rounded-xl border border-gray-200 bg-white p-4 shadow-card dark:border-gray-800 dark:bg-gray-900"
                      >
                        <div className="flex flex-col gap-x-4 gap-y-2 sm:flex-row">
                          <span className="font-mono text-sm font-medium whitespace-nowrap tabular-nums text-gray-700 sm:w-40 sm:shrink-0 dark:text-gray-300">
                            {row.timeLabel}
                          </span>
                          <div className="min-w-0 flex-1">
                            <div className="flex flex-wrap items-center gap-2">
                              <p className="text-base font-semibold tracking-tight">{row.title}</p>
                              <PublicSlotChips slot={row} />
                            </div>
                            {row.description ? (
                              /*
                               * The full abstract is in the SSR HTML twice on
                               * purpose — once clamped in the summary, once
                               * whole in the body — so it is readable with
                               * styles and scripts off. `group-open:hidden`
                               * drops the clamped copy the moment the details
                               * opens, or an expanded card would show its
                               * first three lines a second time.
                               */
                              <details
                                data-session-description
                                className="group mt-2 text-sm leading-6 text-gray-600 dark:text-gray-300"
                              >
                                {/*
                                  * `list-none` plus the WebKit marker hide kills
                                  * the default disclosure ▶ in every engine: it
                                  * otherwise takes a line of its own ABOVE the
                                  * abstract, because the summary's first child is
                                  * a clamped block. The toggle IS the "Show more"
                                  * control — one inline row, a caret that turns
                                  * ▸→▾ on open — so there is no second, orphaned
                                  * marker anywhere on the card.
                                  */}
                                <summary className="cursor-pointer list-none [&::-webkit-details-marker]:hidden">
                                  <span className="line-clamp-3 group-open:hidden">
                                    {row.description}
                                  </span>
                                  <span className={`${linkClass} mt-1 inline-flex items-center gap-1`}>
                                    <span className="group-open:hidden">Show more</span>
                                    <span className="hidden group-open:inline">Show less</span>
                                    <span
                                      aria-hidden="true"
                                      className="text-[0.85em] leading-none transition-transform duration-150 group-open:rotate-90"
                                    >
                                      ▸
                                    </span>
                                  </span>
                                </summary>
                                <p className="mt-2">{row.description}</p>
                              </details>
                            ) : null}
                            <PublicSpeakerList sessionId={row.id} speakers={row.speakers} eventSlug={event.slug} />
                            <div className="mt-3 flex flex-wrap items-center gap-3">
                              {hydrated ? (
                                <button
                                  type="button"
                                  data-star-session={row.id}
                                  aria-pressed={starred}
                                  aria-label={`${starred ? "Remove " : "Add "}${row.title}${starred ? " from my schedule" : " to my schedule"}`}
                                  className={buttonClass("secondary", "sm")}
                                  onClick={() =>
                                    setStarredIds((current) => {
                                      const next = new Set(current);
                                      if (next.has(row.id)) next.delete(row.id);
                                      else next.add(row.id);
                                      return next;
                                    })
                                  }
                                >
                                  <span aria-hidden="true">{starred ? "★" : "☆"}</span>{" "}
                                  {starred ? "In my schedule" : "Add to my schedule"}
                                </button>
                              ) : null}
                              <Link
                                to={detailHref}
                                aria-label={`Session details — ${row.title}`}
                                className={linkClass}
                              >
                                Details
                              </Link>
                            </div>
                          </div>
                        </div>
                      </li>
                    );
                  })}
                </ol>
              </section>
            ))
          )}
        </>
      )}
    </Shell>
  );
}
