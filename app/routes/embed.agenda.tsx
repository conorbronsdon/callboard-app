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
import { buildEmbedXml } from "~/lib/embeds";
import { resolveEmbedOptions } from "~/lib/embeds.server";
import type { Route } from "./+types/embed.agenda";

export function meta({ loaderData }: Route.MetaArgs) {
  const event = loaderData?.event?.name;
  return [{ title: event ? `Agenda — ${event}` : "Agenda — callboard" }];
}

async function loaderImpl({ params, request }: Route.LoaderArgs) {
  const url = new URL(request.url);
  const { theme, track, accent, density, format, customCss, hiddenFields } =
    await resolveEmbedOptions(params.slug, url, "agenda");
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
  const sessions = presentedDays.flatMap((day) =>
    day.sessions.map((slot) => ({
      id: slot.id,
      title: slot.title,
      startsAt: slot.startsAtMs,
      endsAt: null,
      ...(!hidden.has("room") ? { room: slot.roomName } : {}),
      ...(!hidden.has("track") ? { track: slot.trackName } : {}),
    })),
  );

  if (format === "json") {
    return Response.json({ event, sessions, total });
  }
  if (format === "xml") {
    return new Response(buildEmbedXml("agenda", "session", sessions), {
      headers: { "Content-Type": "application/xml; charset=utf-8" },
    });
  }

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

export const loader = loaderImpl as (
  args: Route.LoaderArgs,
) => Promise<Exclude<Awaited<ReturnType<typeof loaderImpl>>, Response>>;

export default function EmbedAgenda({ loaderData }: Route.ComponentProps) {
  const { event, days, total, theme, track, accent, density, customCss } = loaderData;
  return (
    <EmbedShell
      theme={theme}
      accent={accent}
      density={density}
      customCss={customCss}
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
