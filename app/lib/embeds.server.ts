import { asc, eq } from "drizzle-orm";

import { getDb } from "~/db/client.server";
import { events, tracks } from "~/db/schema";
import {
  parseAccent,
  parseDensity,
  parseTheme,
  readSavedEmbeds,
  resolveTrackRef,
  type EmbedDensity,
  type EmbedTheme,
  type EmbedTrackRef,
  type EmbedWidgetId,
  type SavedEmbed,
} from "~/lib/embeds";

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
    };
  }

  return {
    theme: parseTheme(url.searchParams.get("theme")),
    track: url.searchParams.get("track")?.trim() || null,
    accent: parseAccent(url.searchParams.get("accent")),
    density: parseDensity(url.searchParams.get("density")),
  };
}
