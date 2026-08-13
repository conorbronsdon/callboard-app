/**
 * Chrome-less schedule widget for embedding in a third-party page.
 *
 * Deliberately NOT the public page in a smaller box. The public schedule is
 * progressively enhanced — live search, facet selects, and a localStorage
 * itinerary whose filter state is half in React state and half in the URL. An
 * iframe on somebody else's site is the wrong home for all of that: it cannot
 * own the address bar, so the URL half of that pair would be permanently
 * stale. The widget is therefore SSR-only and configured by the host, via
 * query params or a saved embed, and adds no client JS.
 *
 * The data comes from the same `loadPublicSchedule` the public page uses and
 * renders through the same chips and speaker list, so a field cannot appear on
 * one surface and be missing on the other (EMB-16).
 */
import { EmbedScheduleList } from "~/components/schedule-list";
import { loadPublicSchedule } from "~/lib/agenda/public-schedule.server";
import { EMPTY_FILTER, filterDays, countSessions } from "~/lib/agenda/public-schedule";
import { resolveEmbedOptions } from "~/lib/embeds.server";
import { EmbedShell } from "~/components/embed-shell";
import type { Route } from "./+types/embed.schedule";

export async function loader({ params, request }: Route.LoaderArgs) {
  const url = new URL(request.url);
  const { theme, track, accent, density } = await resolveEmbedOptions(
    params.slug,
    url,
    "schedule",
  );

  const { event, days } = await loadPublicSchedule(params.slug);
  /*
   * Reuse the public page's own filter, so "Agents" means the same thing in
   * both places. `filterDays` matches a track exactly; the widget accepts a
   * case-insensitive name because the value travels through a hand-editable
   * iframe src, so it is resolved against the real facet list first.
   */
  const resolvedTrack = track
    ? (days
        .flatMap((day) => day.sessions)
        .map((slot) => slot.trackName)
        .find((name) => name?.toLowerCase() === track.toLowerCase()) ?? track)
    : "";
  const visibleDays = track
    ? filterDays(days, { ...EMPTY_FILTER, track: resolvedTrack }, null)
    : days;

  return {
    event,
    days: visibleDays,
    total: countSessions(visibleDays),
    theme,
    track,
    accent,
    density,
  };
}

export default function EmbedSchedule({ loaderData }: Route.ComponentProps) {
  const { event, days, total, theme, track, accent, density } = loaderData;

  return (
    <EmbedShell
      theme={theme}
      accent={accent}
      density={density}
      eyebrow="Schedule"
      title={event.name}
      testId="embed-schedule"
      sourceHref={`/e/${event.slug}/schedule`}
    >
      <EmbedScheduleList
        days={days}
        total={total}
        timezone={event.timezone}
        density={density}
        emptyState={
          track
            ? {
                title: `No published sessions match “${track}”.`,
                description: "Try another track or view the complete published schedule.",
              }
            : undefined
        }
      />
    </EmbedShell>
  );
}
