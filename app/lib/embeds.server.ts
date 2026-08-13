import { asc, eq } from "drizzle-orm";

import { getDb } from "~/db/client.server";
import { events, tracks } from "~/db/schema";
import { EMPTY_FILTER, filterDays } from "~/lib/agenda/public-schedule";
import { loadPublicSchedule } from "~/lib/agenda/public-schedule.server";
import {
  buildEmbedXml,
  isEmbedWidgetId,
  parseAccent,
  parseCustomCss,
  parseDensity,
  parseFormat,
  parseHiddenFields,
  parseTheme,
  readSavedEmbeds,
  resolveTrackRef,
  type EmbedDensity,
  type EmbedFormat,
  type EmbedTheme,
  type EmbedTrackRef,
  type EmbedWidgetId,
  type SavedEmbed,
} from "~/lib/embeds";
import { getPublicSpeakerEvent, listPublicSpeakers } from "~/lib/public-speakers.server";

/** Id AND name: the picker shows the name, the saved row stores the id. */
export async function listEmbedTracks(eventId: string): Promise<EmbedTrackRef[]> {
  return getDb()
    .select({ id: tracks.id, name: tracks.name })
    .from(tracks)
    .where(eq(tracks.eventId, eventId))
    .orderBy(asc(tracks.order), asc(tracks.name));
}

export async function loadEventEmbedSettings(eventId: string): Promise<{
  settings: Record<string, unknown> | null;
  embeds: SavedEmbed[];
}> {
  const event = await getDb().query.events.findFirst({ where: eq(events.id, eventId) });
  const settings = event?.settings ?? null;
  return { settings, embeds: readSavedEmbeds(settings) };
}

export async function writeEventEmbedSettings(
  eventId: string,
  settings: Record<string, unknown>,
): Promise<void> {
  await getDb()
    .update(events)
    .set({ settings, updatedAt: new Date() })
    .where(eq(events.id, eventId));
}

export interface ResolvedEmbedOptions {
  theme: EmbedTheme;
  track: string | null;
  accent: string | null;
  density: EmbedDensity;
  format: EmbedFormat;
  customCss: string | null;
  hiddenFields: string[];
}

export async function resolveEmbedOptions(
  slug: string,
  url: URL,
  widget: EmbedWidgetId,
): Promise<ResolvedEmbedOptions> {
  const embedId = url.searchParams.get("embed");
  if (embedId) {
    const event = await getDb().query.events.findFirst({ where: eq(events.slug, slug) });
    const saved = event
      ? (readSavedEmbeds(event).find((embed) => embed.id === embedId) ?? null)
      : null;
    if (!event || !saved || !saved.enabled || saved.widget !== widget) {
      throw new Response("Embed not found", { status: 404 });
    }
    return {
      theme: saved.theme,
      // Stored as a track id since the rename lane; legacy rows hold the name
      // and resolve to themselves. Only queried when there is a filter to
      // resolve, so an unfiltered widget still costs one query.
      track: saved.track
        ? resolveTrackRef(saved.track, await listEmbedTracks(event.id))
        : null,
      accent: saved.accent,
      density: saved.density,
      format: saved.format,
      customCss: parseCustomCss(saved.customCss),
      hiddenFields: parseHiddenFields(widget, saved.hiddenFields),
    };
  }

  return {
    theme: parseTheme(url.searchParams.get("theme")),
    track: url.searchParams.get("track")?.trim() || null,
    accent: parseAccent(url.searchParams.get("accent")),
    density: parseDensity(url.searchParams.get("density")),
    format: parseFormat(url.searchParams.get("format")),
    // Custom CSS is trusted only after an authenticated organizer saves it;
    // never accept free-form CSS from an anonymous public query parameter.
    customCss: null,
    hiddenFields: parseHiddenFields(widget, url.searchParams.getAll("hide")),
  };
}

const EMBED_PATH = /^\/embed\/([^/]+)\/([^/]+)\/?$/;

/**
 * The JSON/XML data-export path for the embed widgets, served from the WORKER
 * entrypoint (`workers/app.ts`) rather than the widgets' own route loaders.
 *
 * A React Router v8 UI route (any module with a `default` component export)
 * always renders its component around whatever the loader returns during a
 * normal document request — a single-fetch document load merges every matched
 * route's loader result into one `loaderData` tree, so it can layer parent
 * layouts around a leaf's data. A `Response` returned from a leaf loader gets
 * unwrapped (JSON-parsed when possible) into that tree instead of being sent
 * back verbatim; only a `queryRoute()`-style single-route `.data` fetch (never
 * issued by a plain browser navigation to `?format=json`) honours a raw
 * `Response` short-circuit. That is why `embed.schedule.tsx` (and its three
 * siblings) returning `Response.json(...)`/`new Response(xml, ...)` straight
 * from their loaders silently became a full HTML document instead (JSON has
 * an `event` key the component happens to read, so it partially renders) or a
 * 500 (XML has none, so `event.name` throws) — every matched-route Response
 * gets folded into loaderData, never passed through raw. `public.calendar.ts`
 * and the CSV export routes dodge this because they are resource routes: no
 * `default` export means there is no component for React Router to render
 * around the loader's Response, so it IS the final response.
 *
 * The stable `?embed=<id>` URL a saved embed hands out has to keep working
 * regardless of which format it is saved as, so the export can't simply move
 * to its own path (`.json`/`.xml`) the way the CSV/iCal routes do — the same
 * URL must be able to answer with HTML or with data depending on what is
 * stored. Resolving format here, before React Router ever sees the request,
 * and returning the raw `Response` straight from the Worker's `fetch` handler
 * is the only place that distinction can still produce a literal JSON/XML
 * body: it never enters the router's document-rendering path at all.
 *
 * Returns null for anything that is not a resolved json/xml embed export —
 * including a 404/format-resolution failure — so the caller falls through to
 * the normal React Router request handling unchanged (that keeps the existing
 * "disabled/unknown saved embed returns 404" behaviour exactly as it already
 * was, produced by the route loader's own `resolveEmbedOptions` call and
 * error boundary, not duplicated here).
 */
export async function resolveEmbedExportResponse(url: URL): Promise<Response | null> {
  const match = EMBED_PATH.exec(url.pathname);
  if (!match) return null;
  const [, rawSlug, rawWidget] = match;
  if (!isEmbedWidgetId(rawWidget)) return null;
  const widget = rawWidget;
  // Cheap bailout: an unparameterised `/embed/:slug/:widget` request can only
  // ever resolve to the default format (iframe), so skip the DB round trip
  // `resolveEmbedOptions` needs for a saved-embed lookup entirely.
  if (!url.searchParams.has("embed") && !url.searchParams.has("format")) return null;
  const slug = decodeURIComponent(rawSlug);

  let resolved: ResolvedEmbedOptions;
  try {
    resolved = await resolveEmbedOptions(slug, url, widget);
  } catch {
    // Not-found/disabled saved embeds throw a Response here too; let React
    // Router's own loader run and produce its already-tested 404.
    return null;
  }
  const { format, track, hiddenFields } = resolved;
  if (format !== "json" && format !== "xml") return null;

  const hidden = new Set(hiddenFields);

  if (widget === "schedule" || widget === "agenda") {
    let data;
    try {
      data = await loadPublicSchedule(slug);
    } catch (error) {
      return error instanceof Response ? error : new Response("Event not found", { status: 404 });
    }
    const { event, days } = data;
    const resolvedTrack = track
      ? (days
          .flatMap((day) => day.sessions)
          .map((slot) => slot.trackName)
          .find((name) => name?.toLowerCase() === track.toLowerCase()) ?? track)
      : "";
    const visibleDays = track
      ? filterDays(days, { ...EMPTY_FILTER, track: resolvedTrack }, null)
      : days;
    const sessions = visibleDays.flatMap((day) =>
      day.sessions.map((slot) => ({
        id: slot.id,
        title: slot.title,
        startsAt: slot.startsAtMs,
        endsAt: null,
        ...(!hidden.has("room") ? { room: slot.roomName } : {}),
        ...(!hidden.has("track") ? { track: slot.trackName } : {}),
      })),
    );
    if (format === "json") return Response.json({ event, sessions, total: sessions.length });
    return new Response(buildEmbedXml(widget, "session", sessions), {
      headers: { "Content-Type": "application/xml; charset=utf-8" },
    });
  }

  // speakers | gallery
  const db = getDb();
  const event = await getPublicSpeakerEvent(db, slug);
  if (!event) return new Response("Event not found", { status: 404 });
  const { speakers, total } = await listPublicSpeakers(db, event.id, "");
  const exportSpeakers = speakers.map((speaker) => ({
    id: speaker.id,
    name: speaker.displayName,
    ...(!hidden.has("title") ? { title: speaker.title } : {}),
    ...(!hidden.has("company") ? { company: speaker.company } : {}),
    sessionCount: speaker.sessionCount,
  }));
  if (format === "json") {
    return Response.json({ event: { name: event.name, slug: event.slug }, speakers: exportSpeakers, total });
  }
  return new Response(buildEmbedXml(widget, "speaker", exportSpeakers), {
    headers: { "Content-Type": "application/xml; charset=utf-8" },
  });
}
