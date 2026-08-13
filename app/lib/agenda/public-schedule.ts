/**
 * Public-schedule shaping, filters, facets and personal-schedule storage.
 *
 * Pure: no bindings, database types, browser globals or current-clock reads.
 * Route loaders and the hydrated schedule component use the same functions so
 * the server-rendered entry state cannot drift from the live client state.
 */
import { formatRangeLabel } from "~/lib/agenda/schedule";

export interface PublicSpeaker {
  personId: string;
  name: string;
  title: string | null;
  company: string | null;
}

export interface PublicSlot {
  id: string;
  title: string;
  description: string | null;
  timeLabel: string;
  startsAtMs: number;
  roomName: string | null;
  trackName: string | null;
  trackColor: string | null;
  formatName: string | null;
  speakers: PublicSpeaker[];
}

export interface PublicDay {
  day: string;
  label: string;
  sessions: PublicSlot[];
}

export interface PublicSlotRow {
  id: string;
  title: string;
  description: string | null;
  startsAt: Date | number;
  endsAt: Date | number | null;
  roomName: string | null;
  trackName: string | null;
  trackColor: string | null;
  formatName: string | null;
}

/** One mapping owns the values shared by schedule cards and session details. */
export function toPublicSlot(
  row: PublicSlotRow,
  speakers: readonly PublicSpeaker[],
  timeZone: string,
): PublicSlot {
  const startsAtMs = row.startsAt instanceof Date ? row.startsAt.getTime() : row.startsAt;
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    timeLabel: formatRangeLabel(row.startsAt, row.endsAt, timeZone),
    startsAtMs,
    roomName: row.roomName,
    trackName: row.trackName,
    trackColor: row.trackColor,
    formatName: row.formatName,
    speakers: speakers.map((speaker) => ({ ...speaker })),
  };
}

export interface ScheduleFilter {
  q: string;
  track: string;
  format: string;
  room: string;
  day: string;
}

export const EMPTY_FILTER: ScheduleFilter = {
  q: "",
  track: "",
  format: "",
  room: "",
  day: "",
};

export function parseScheduleFilter(params: URLSearchParams): ScheduleFilter {
  return {
    q: (params.get("q") ?? "").trim(),
    track: (params.get("track") ?? "").trim(),
    format: (params.get("format") ?? "").trim(),
    room: (params.get("room") ?? "").trim(),
    day: (params.get("day") ?? "").trim(),
  };
}

export function scheduleFilterQuery(filter: ScheduleFilter): string {
  const params = new URLSearchParams();
  for (const key of ["q", "track", "format", "room", "day"] as const) {
    const value = filter[key].trim();
    if (value) params.set(key, value);
  }
  return params.toString();
}

export function scheduleFilterUrl(pathname: string, filter: ScheduleFilter): string {
  const query = scheduleFilterQuery(filter);
  return query ? `${pathname}?${query}` : pathname;
}

export function matchesQuery(slot: PublicSlot, q: string): boolean {
  const needle = q.trim().toLocaleLowerCase();
  if (!needle) return true;
  if (slot.title.toLocaleLowerCase().includes(needle)) return true;
  if (slot.description?.toLocaleLowerCase().includes(needle)) return true;
  return slot.speakers.some((speaker) => speaker.name.toLocaleLowerCase().includes(needle));
}

export function filterDays(
  days: readonly PublicDay[],
  filter: ScheduleFilter,
  starredIds: ReadonlySet<string> | null,
): PublicDay[] {
  const filtered: PublicDay[] = [];
  for (const day of days) {
    if (filter.day && day.day !== filter.day) continue;
    const sessions = day.sessions.filter((slot) => {
      if (starredIds !== null && !starredIds.has(slot.id)) return false;
      if (!matchesQuery(slot, filter.q)) return false;
      if (filter.track && slot.trackName !== filter.track) return false;
      if (filter.format && slot.formatName !== filter.format) return false;
      if (filter.room && slot.roomName !== filter.room) return false;
      return true;
    });
    if (sessions.length > 0) filtered.push({ ...day, sessions: [...sessions] });
  }
  return filtered;
}

export function countSessions(days: readonly PublicDay[]): number {
  return days.reduce((total, day) => total + day.sessions.length, 0);
}

export function facetsOf(days: readonly PublicDay[]): {
  tracks: string[];
  formats: string[];
  rooms: string[];
} {
  const tracks = new Set<string>();
  const formats = new Set<string>();
  const rooms = new Set<string>();
  for (const slot of days.flatMap((day) => day.sessions)) {
    if (slot.trackName) tracks.add(slot.trackName);
    if (slot.formatName) formats.add(slot.formatName);
    if (slot.roomName) rooms.add(slot.roomName);
  }
  const sorted = (values: Set<string>) => [...values].sort((a, b) => a.localeCompare(b));
  return { tracks: sorted(tracks), formats: sorted(formats), rooms: sorted(rooms) };
}

/** Human-readable title/company text with no empty punctuation. */
export function speakerRole(speaker: PublicSpeaker): string | null {
  const parts = [speaker.title, speaker.company].filter(
    (value): value is string => typeof value === "string" && value.trim().length > 0,
  );
  return parts.length > 0 ? parts.join(", ") : null;
}

/** Corrupt, non-array and non-string entries restore as an empty/clean list. */
export function parseStoredSchedule(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return [...new Set(parsed.filter((id): id is string => typeof id === "string" && id !== ""))];
  } catch {
    return [];
  }
}

export function pruneStoredSchedule(
  ids: readonly string[],
  validIds: ReadonlySet<string>,
): string[] {
  return [...new Set(ids.filter((id) => validIds.has(id)))];
}

export function serialiseStoredSchedule(ids: Iterable<string>): string {
  return JSON.stringify([...new Set(ids)]);
}
