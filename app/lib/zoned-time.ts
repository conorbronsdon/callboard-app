/**
 * Converting between an HTML `datetime-local` value and an epoch, in a named
 * IANA timezone. Pure — `Intl` only, no dependency.
 *
 * Why this exists: the admin types "Sep 15, 11:59 PM" meaning the EVENT's
 * timezone, but a Worker runs in UTC, so `new Date("2026-09-15T23:59")` would
 * store 11:59 PM UTC — 7 hours early in Los Angeles. The close date gates both
 * the public form and the draft-reminder job, so that is a real bug, not a
 * rounding error.
 */

/**
 * Milliseconds to add to a UTC instant to get the local wall clock in `timeZone`.
 * Negative west of Greenwich (-7h for PDT).
 */
function zoneOffsetMs(instant: number, timeZone: string): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts: Record<string, string> = {};
  for (const part of dtf.formatToParts(new Date(instant))) parts[part.type] = part.value;

  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    // Intl renders midnight as "24" in some ICU versions of the h23 cycle.
    Number(parts.hour) % 24,
    Number(parts.minute),
    Number(parts.second),
  );
  return asUtc - instant;
}

/**
 * A `datetime-local` value: `YYYY-MM-DDTHH:MM`, optionally with seconds.
 * The shape is checked explicitly because `Date.parse` is lenient enough to
 * turn `"not-a-date:00Z"` into a real instant (the year 2000) rather than NaN.
 */
const DATETIME_LOCAL = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/;

/** `"2026-09-15T23:59"` + `"America/Los_Angeles"` → epoch ms. Invalid input → null. */
export function zonedInputToEpoch(value: string, timeZone: string): number | null {
  if (!value || !DATETIME_LOCAL.test(value)) return null;
  const naive = Date.parse(`${value.slice(0, 16)}:00Z`);
  if (Number.isNaN(naive)) return null;

  // Two passes settle a DST boundary: the offset depends on the instant, and
  // the instant depends on the offset.
  let epoch = naive - zoneOffsetMs(naive, timeZone);
  epoch = naive - zoneOffsetMs(epoch, timeZone);
  return epoch;
}

/** Epoch ms → `"2026-09-15T23:59"` for a `datetime-local` input, in `timeZone`. */
export function epochToZonedInput(
  epoch: number | Date | null | undefined,
  timeZone: string,
): string {
  if (epoch === null || epoch === undefined) return "";
  const ms = epoch instanceof Date ? epoch.getTime() : epoch;
  if (!Number.isFinite(ms)) return "";
  return new Date(ms + zoneOffsetMs(ms, timeZone)).toISOString().slice(0, 16);
}

/** "September 15 at 11:59 PM PDT" — the prose the public form renders. */
export function formatInZone(
  epoch: number | Date | null | undefined,
  timeZone: string,
): string | null {
  if (epoch === null || epoch === undefined) return null;
  const ms = epoch instanceof Date ? epoch.getTime() : epoch;
  if (!Number.isFinite(ms)) return null;
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    month: "long",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(new Date(ms));
}
