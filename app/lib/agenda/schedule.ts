/**
 * Day/slot arithmetic for the agenda, in the EVENT's timezone.
 *
 * A Worker runs in UTC but an organiser thinks "Tuesday, 2:30 PM" in the city
 * the conference is in. Every helper here therefore takes the event timezone and
 * routes through `~/lib/zoned-time` rather than `Date` getters, which would
 * silently bucket a 5 PM Los Angeles session onto the following day.
 *
 * Pure — no I/O, no DB types — so the whole grid is unit-testable.
 */
import { epochToZonedInput, zonedInputToEpoch } from "~/lib/zoned-time";

const DAY_MS = 86_400_000;

/** `YYYY-MM-DD` in the event timezone. */
export type DayKey = string;
/** `HH:MM`, 24-hour, in the event timezone. */
export type TimeKey = string;

export const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;
export const TIME_KEY = /^([01]\d|2[0-3]):[0-5]\d$/;

export function isDayKey(value: unknown): value is DayKey {
  return typeof value === "string" && DAY_KEY.test(value);
}

export function isTimeKey(value: unknown): value is TimeKey {
  return typeof value === "string" && TIME_KEY.test(value);
}

/** Which programme day an instant falls on, in the event timezone. */
export function dayKeyOf(epoch: number | Date, timeZone: string): DayKey {
  return epochToZonedInput(epoch, timeZone).slice(0, 10);
}

/** Wall-clock `HH:MM` of an instant, in the event timezone. */
export function timeKeyOf(epoch: number | Date, timeZone: string): TimeKey {
  return epochToZonedInput(epoch, timeZone).slice(11, 16);
}

/** `2026-10-07` + `14:30` + zone → epoch ms. Invalid input → null. */
export function slotEpoch(day: DayKey, time: TimeKey, timeZone: string): number | null {
  if (!isDayKey(day) || !isTimeKey(time)) return null;
  return zonedInputToEpoch(`${day}T${time}`, timeZone);
}

/**
 * The programme days: the event's own date range, unioned with any day that
 * already has a session on it (an admin can schedule outside the declared range
 * — better to show the stray day than to hide the session).
 *
 * Stepping by 24 h and re-deriving the key in-zone each time is DST-safe: an
 * offset shift of ±1 h can duplicate a key (deduped by the Set) but never skips
 * one.
 */
export function eventDays(
  startsOn: number | Date | null | undefined,
  endsOn: number | Date | null | undefined,
  scheduledStarts: (number | Date)[],
  timeZone: string,
  maxDays = 62,
): DayKey[] {
  const days = new Set<DayKey>();

  const start = startsOn instanceof Date ? startsOn.getTime() : startsOn;
  const end = endsOn instanceof Date ? endsOn.getTime() : endsOn;
  if (typeof start === "number" && Number.isFinite(start)) {
    const last = typeof end === "number" && Number.isFinite(end) && end > start ? end : start;
    for (let i = 0; i <= maxDays; i += 1) {
      const cursor = start + i * DAY_MS;
      if (cursor > last) break;
      days.add(dayKeyOf(cursor, timeZone));
    }
    // The final step can land past `last` while `last` itself is still on an
    // unlisted day (a range that is not a whole number of 24 h periods).
    days.add(dayKeyOf(last, timeZone));
  }

  for (const instant of scheduledStarts) days.add(dayKeyOf(instant, timeZone));

  return [...days].sort();
}

/** ISO week bucket `YYYY-Www` — the Week view groups days by this. */
export function isoWeekOf(day: DayKey): string {
  const date = new Date(`${day}T00:00:00Z`);
  // Thursday of the same ISO week determines the year and the week number.
  const dayOfWeek = (date.getUTCDay() + 6) % 7; // Monday = 0
  date.setUTCDate(date.getUTCDate() - dayOfWeek + 3);
  const isoYear = date.getUTCFullYear();
  const firstThursday = new Date(Date.UTC(isoYear, 0, 4));
  const firstDayOfWeek = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDayOfWeek + 3);
  const week = 1 + Math.round((date.getTime() - firstThursday.getTime()) / (7 * DAY_MS));
  return `${isoYear}-W${String(week).padStart(2, "0")}`;
}

/** "Wed Oct 7, 2026" — the heading over a day column. */
export function formatDayLabel(day: DayKey, timeZone: string): string {
  const epoch = slotEpoch(day, "12:00", timeZone);
  if (epoch === null) return day;
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(epoch));
}

/** "2:30 PM" — the time shown on a card. */
export function formatTimeLabel(epoch: number | Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "numeric",
    minute: "2-digit",
  }).format(epoch instanceof Date ? epoch : new Date(epoch));
}

/** "2:30 PM – 3:00 PM" for a card, or "2:30 PM" when the end is missing. */
export function formatRangeLabel(
  startsAt: number | Date | null,
  endsAt: number | Date | null,
  timeZone: string,
): string {
  if (startsAt === null) return "Unscheduled";
  const start = formatTimeLabel(startsAt, timeZone);
  if (endsAt === null) return start;
  return `${start} – ${formatTimeLabel(endsAt, timeZone)}`;
}

/** Minutes between two instants, floored at 0. */
export function durationMinutes(
  startsAt: number | Date | null,
  endsAt: number | Date | null,
): number | null {
  if (startsAt === null || endsAt === null) return null;
  const a = startsAt instanceof Date ? startsAt.getTime() : startsAt;
  const b = endsAt instanceof Date ? endsAt.getTime() : endsAt;
  if (!Number.isFinite(a) || !Number.isFinite(b) || b <= a) return null;
  return Math.round((b - a) / 60_000);
}

export const DEFAULT_SLOT_MINUTES = 30;
export const DEFAULT_DURATION_MINUTES = 30;
export const DAY_START_HOUR = 8;
export const DAY_END_HOUR = 20;

/**
 * The row labels of the Day board: `08:00`, `08:30`, … `19:30`.
 * A fixed 8 AM–8 PM window keeps the grid one screenful; sessions outside it
 * still render (the List/Room views are exhaustive) and the board notes them.
 */
export function slotTimes(
  stepMinutes = DEFAULT_SLOT_MINUTES,
  startHour = DAY_START_HOUR,
  endHour = DAY_END_HOUR,
): TimeKey[] {
  const times: TimeKey[] = [];
  for (let minutes = startHour * 60; minutes < endHour * 60; minutes += stepMinutes) {
    const hour = Math.floor(minutes / 60);
    const minute = minutes % 60;
    times.push(`${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`);
  }
  return times;
}

/**
 * Which grid row a session lands in: the LAST slot at or before its start, so a
 * 2:45 PM session shows up in the 2:30 PM row rather than vanishing.
 * Returns null when the session starts before the first slot or at/after the last.
 */
export function slotForTime(time: TimeKey, slots: TimeKey[]): TimeKey | null {
  if (!isTimeKey(time) || slots.length === 0) return null;
  let match: TimeKey | null = null;
  for (const slot of slots) {
    if (slot <= time) match = slot;
    else break;
  }
  return match;
}

/** The droppable id for a room×time cell, and its inverse. */
export function slotId(roomId: string, day: DayKey, time: TimeKey): string {
  return `slot|${roomId}|${day}|${time}`;
}

export function parseSlotId(
  value: string,
): { roomId: string; day: DayKey; time: TimeKey } | null {
  const parts = value.split("|");
  if (parts.length !== 4 || parts[0] !== "slot") return null;
  const [, roomId, day, time] = parts;
  if (!roomId || !isDayKey(day) || !isTimeKey(time)) return null;
  return { roomId, day, time };
}
