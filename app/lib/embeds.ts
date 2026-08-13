export const EMBED_WIDGETS = [
  {
    id: "schedule",
    label: "Schedule",
    path: "schedule",
    supportsTrackFilter: true,
    feedPath: "schedule.ics",
    description: "The event's published agenda, grouped by day and start time.",
  },
  {
    id: "agenda",
    label: "Agenda by day",
    path: "agenda",
    supportsTrackFilter: true,
    feedPath: "schedule.ics",
    description: "A day-by-day agenda: one heading per day, then time, title and room.",
  },
  {
    id: "speakers",
    label: "Speakers",
    path: "speakers",
    supportsTrackFilter: false,
    feedPath: null,
    description: "The published speaker directory, ordered by surname.",
  },
  {
    id: "gallery",
    label: "Speaker gallery",
    path: "gallery",
    supportsTrackFilter: false,
    feedPath: null,
    description: "A photo-tile grid of the published speakers, ordered by surname.",
  },
  /*
   * Adding another widget is one entry here — routes and admin cards both
   * derive from this catalogue.
   *
   * ⚠️ One thing does NOT come for free. Every card repeats its controls, so
   * per-card accessible names are load-bearing, not decoration: two controls
   * sharing an accessible name is a confusing page and a Playwright
   * strict-mode failure, which is what the design brief's §6C register
   * forbids. Ids are scoped (`embed-theme-<id>`) AND every control carries an
   * `aria-label` naming its widget, while the visible text stays the short
   * noun — the same shape as `Get Code for <widget>`. Keep that up, and give
   * the e2e locators the widget-qualified name.
   */
] as const;

export type EmbedWidgetId = (typeof EMBED_WIDGETS)[number]["id"];
export type EmbedTheme = "light" | "dark" | "auto";
export type EmbedFormat = "iframe" | "html" | "ical";
export type EmbedDensity = "full" | "compact";

export const EMBED_FORMATS = [
  { id: "iframe", label: "Iframe" },
  { id: "html", label: "Link (HTML)" },
  { id: "ical", label: "Calendar feed (iCal)" },
] as const satisfies readonly { id: EmbedFormat; label: string }[];

export const ACCENT_PATTERN = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

export interface SavedEmbed {
  id: string;
  name: string;
  widget: EmbedWidgetId;
  theme: EmbedTheme;
  track: string | null;
  format: EmbedFormat;
  density: EmbedDensity;
  accent: string | null;
  enabled: boolean;
  createdAt: number;
}

export function parseTheme(value: string | null): EmbedTheme {
  return value === "light" || value === "dark" || value === "auto" ? value : "auto";
}

export function isEmbedFormat(value: string): value is EmbedFormat {
  return value === "iframe" || value === "html" || value === "ical";
}

export function isEmbedDensity(value: string): value is EmbedDensity {
  return value === "full" || value === "compact";
}

export function parseFormat(value: string | null | undefined): EmbedFormat {
  return value && isEmbedFormat(value) ? value : "iframe";
}

export function parseDensity(value: string | null | undefined): EmbedDensity {
  return value && isEmbedDensity(value) ? value : "full";
}

/** The only sanitisation point before an accent may reach an inline style. */
export function parseAccent(value: string | null | undefined): string | null {
  const normalised = value?.trim().toLowerCase() ?? "";
  return ACCENT_PATTERN.test(normalised) ? normalised : null;
}

export interface EmbedTrackRef {
  id: string;
  name: string;
}

/*
 * A saved embed's track filter, normalised at both ends — the shape `parseAccent`
 * has, for the same reason: one function per direction, called by every writer
 * and every reader, so the two cannot drift.
 *
 * `SavedEmbed.track` used to hold a track NAME. Tracks can now be renamed, and a
 * saved embed lives inside an iframe on somebody else's page: a rename silently
 * turned that widget into its empty state, with the organizer's saved-embeds
 * list still printing the old name. New rows therefore store the track ID, and
 * the name is resolved at render.
 *
 * Rows written before this keep working untouched: an id that matches no live
 * track falls through as the raw string, which is exactly the name the widgets
 * already match case-insensitively.
 */

/** Write end: the stored value for a picked track name. */
export function toTrackRef(
  name: string | null | undefined,
  tracks: readonly EmbedTrackRef[],
): string | null {
  const wanted = name?.trim() ?? "";
  if (!wanted) return null;
  const match =
    tracks.find((track) => track.name === wanted) ??
    tracks.find((track) => track.name.toLowerCase() === wanted.toLowerCase());
  return match ? match.id : wanted;
}

/** Read end: the live track name a stored value points at. */
export function resolveTrackRef(
  stored: string | null | undefined,
  tracks: readonly EmbedTrackRef[],
): string | null {
  const raw = stored?.trim() ?? "";
  if (!raw) return null;
  return tracks.find((track) => track.id === raw)?.name ?? raw;
}

export function isEmbedWidgetId(value: string): value is EmbedWidgetId {
  return EMBED_WIDGETS.some((widget) => widget.id === value);
}

export function getEmbedWidget(id: EmbedWidgetId) {
  return EMBED_WIDGETS.find((widget) => widget.id === id)!;
}

export function buildEmbedUrl(options: {
  origin: string;
  slug: string;
  widget: EmbedWidgetId;
  theme?: EmbedTheme;
  track?: string | null;
  accent?: string | null;
  density?: EmbedDensity;
  embedId?: string | null;
}): string {
  const widget = getEmbedWidget(options.widget);
  const base = `${options.origin.replace(/\/$/, "")}/embed/${encodeURIComponent(options.slug)}/${widget.path}`;
  const params = new URLSearchParams();

  if (options.embedId) {
    params.set("embed", options.embedId);
  } else {
    if (options.theme && options.theme !== "auto") params.set("theme", options.theme);
    if (options.track) params.set("track", options.track);
    const accent = parseAccent(options.accent);
    if (accent) params.set("accent", accent);
    if (options.density === "compact") params.set("density", "compact");
  }

  const query = params.toString();
  return query ? `${base}?${query}` : base;
}

export function buildFeedUrl(options: {
  origin: string;
  slug: string;
  widget: EmbedWidgetId;
}): string | null {
  const feedPath = getEmbedWidget(options.widget).feedPath;
  return feedPath
    ? `${options.origin.replace(/\/$/, "")}/e/${encodeURIComponent(options.slug)}/${feedPath}`
    : null;
}

function escapeHtmlAttribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function escapeHtmlText(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

export function buildIframeSnippet(options: {
  url: string;
  eventName: string;
  widgetLabel: string;
}): string {
  const url = escapeHtmlAttribute(options.url);
  const title = escapeHtmlAttribute(`${options.eventName} — ${options.widgetLabel}`);
  return `<iframe src="${url}" width="100%" height="720" style="border:0" loading="lazy" title="${title}"></iframe>`;
}

export function buildSnippet(options: {
  format: EmbedFormat;
  url: string;
  feedUrl: string | null;
  eventName: string;
  widgetLabel: string;
}): string {
  if (options.format === "html") {
    const href = escapeHtmlAttribute(options.url);
    const text = escapeHtmlText(`${options.eventName} — ${options.widgetLabel}`);
    return `<div class="callboard-embed"><a href="${href}" target="_blank" rel="noopener">${text}</a></div>`;
  }
  if (options.format === "ical" && options.feedUrl) {
    const href = escapeHtmlAttribute(options.feedUrl);
    const text = escapeHtmlText(`Subscribe to ${options.eventName} (iCal)`);
    return `<div class="callboard-embed"><a href="${href}" target="_blank" rel="noopener">${text}</a></div>`;
  }
  return buildIframeSnippet(options);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function settingsValue(source: unknown): unknown {
  return isRecord(source) && "settings" in source ? source.settings : source;
}

type StoredSavedEmbed = Omit<SavedEmbed, "format" | "density" | "accent"> & {
  format?: unknown;
  density?: unknown;
  accent?: unknown;
};

function isSavedEmbed(value: unknown): value is StoredSavedEmbed {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === "string" &&
    value.id.length > 0 &&
    typeof value.name === "string" &&
    value.name.trim().length > 0 &&
    value.name.length <= 80 &&
    typeof value.widget === "string" &&
    isEmbedWidgetId(value.widget) &&
    (value.theme === "light" || value.theme === "dark" || value.theme === "auto") &&
    (value.track === null || typeof value.track === "string") &&
    typeof value.enabled === "boolean" &&
    typeof value.createdAt === "number" &&
    Number.isFinite(value.createdAt)
  );
}

/** Parse either an event-like object or its settings value. Invalid entries are ignored. */
export function readSavedEmbeds(source: unknown): SavedEmbed[] {
  const settings = settingsValue(source);
  if (!isRecord(settings) || !Array.isArray(settings.embeds)) return [];
  return settings.embeds.filter(isSavedEmbed).map((embed) => ({
    id: embed.id,
    name: embed.name,
    widget: embed.widget,
    theme: embed.theme,
    track: embed.track,
    enabled: embed.enabled,
    createdAt: embed.createdAt,
    format: parseFormat(typeof embed.format === "string" ? embed.format : null),
    density: parseDensity(typeof embed.density === "string" ? embed.density : null),
    accent: parseAccent(typeof embed.accent === "string" ? embed.accent : null),
  }));
}

function writeEmbeds(settings: unknown, embeds: SavedEmbed[]): Record<string, unknown> {
  return { ...(isRecord(settings) ? settings : {}), embeds };
}

export function upsertSavedEmbed(
  settings: unknown,
  embed: SavedEmbed,
): Record<string, unknown> {
  const existing = readSavedEmbeds(settings);
  const index = existing.findIndex((item) => item.id === embed.id);
  const embeds = [...existing];
  if (index === -1) embeds.push(embed);
  else embeds[index] = embed;
  return writeEmbeds(settings, embeds);
}

export interface SavedEmbedMutation {
  settings: Record<string, unknown>;
  found: boolean;
}

export function toggleSavedEmbed(settings: unknown, id: string): SavedEmbedMutation {
  const existing = readSavedEmbeds(settings);
  const found = existing.some((embed) => embed.id === id);
  return {
    settings: writeEmbeds(
      settings,
      existing.map((embed) =>
        embed.id === id ? { ...embed, enabled: !embed.enabled } : embed,
      ),
    ),
    found,
  };
}

export function removeSavedEmbed(settings: unknown, id: string): SavedEmbedMutation {
  const existing = readSavedEmbeds(settings);
  const found = existing.some((embed) => embed.id === id);
  return {
    settings: writeEmbeds(
      settings,
      existing.filter((embed) => embed.id !== id),
    ),
    found,
  };
}
