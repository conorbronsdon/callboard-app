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

export function meta({ loaderData }: Route.MetaArgs) {
  const event = loaderData?.event?.name;
  return [{ title: event ? `Schedule — ${event}` : "Schedule — callboard" }];
}

/*
 * JSON/XML export for this widget is served from `workers/app.ts`
 * (`resolveEmbedExportResponse`), never from this loader. React Router
 * always renders `EmbedSchedule` around whatever a document-request loader
 * returns, so a `Response` returned here would be folded into `loaderData`
 * instead of sent back verbatim — see that function's doc comment.
 */
export async function loader({ params, request }: Route.LoaderArgs) {
  const url = new URL(request.url);
  const { theme, track, accent, density, customCss, hiddenFields } = await resolveEmbedOptions(
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
  const hidden = new Set(hiddenFields);
  const presentedDays = visibleDays.map((day) => ({
    ...day,
    sessions: day.sessions.map((slot) => ({
      ...slot,
      roomName: hidden.has("room") ? null : slot.roomName,
      trackName: hidden.has("track") ? null : slot.trackName,
      trackColor: hidden.has("track") ? null : slot.trackColor,
    })),
  }));
  const total = countSessions(presentedDays);

  return {
    event,
    days: presentedDays,
    total,
    theme,
    track,
    accent,
    density,
    customCss,
    hiddenFields,
  };
}

export default function EmbedSchedule({ loaderData }: Route.ComponentProps) {
  const { event, days, total, theme, track, accent, density, customCss } = loaderData;

  return (
    <EmbedShell
      theme={theme}
      accent={accent}
      density={density}
      customCss={customCss}
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
