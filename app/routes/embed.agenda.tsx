/**
 * Agenda-by-day widget: the same published sessions as `embed.schedule`, in the
 * shape a host page usually wants beside a hero — one heading per day carrying
 * that day's count, then a time/title/room row per session.
 *
 * It is a separate widget rather than a `?layout=` on the schedule one because
 * a saved embed is addressed by widget id: the id is what `resolveEmbedOptions`
 * checks before serving, so a schedule embed handle can never quietly start
 * rendering an agenda if somebody edits the stored row.
 *
 * Data comes from the same `loadPublicSchedule` and the same track filter as
 * the public page, so a field cannot appear on one surface and not the other.
 */
import { EmbedShell } from "~/components/embed-shell";
import { EmbedAgendaByDay } from "~/components/schedule-list";
import { EMPTY_FILTER, countSessions, filterDays } from "~/lib/agenda/public-schedule";
import { loadPublicSchedule } from "~/lib/agenda/public-schedule.server";
import { resolveEmbedOptions } from "~/lib/embeds.server";
import type { Route } from "./+types/embed.agenda";

export async function loader({ params, request }: Route.LoaderArgs) {
  const url = new URL(request.url);
  const { theme, track, accent, density } = await resolveEmbedOptions(
    params.slug,
    url,
    "agenda",
  );
  const { event, days } = await loadPublicSchedule(params.slug);
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

export default function EmbedAgenda({ loaderData }: Route.ComponentProps) {
  const { event, days, total, theme, track, accent, density } = loaderData;
  return (
    <EmbedShell
      theme={theme}
      accent={accent}
      density={density}
      eyebrow="Agenda by day"
      title={event.name}
      testId="embed-agenda"
      sourceHref={`/e/${event.slug}/schedule`}
    >
      <EmbedAgendaByDay
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
