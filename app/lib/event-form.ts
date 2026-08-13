/**
 * The pure half of the event create/edit forms: what a legal slug looks like,
 * and how a stored date crosses an `<input type="date">` and comes back.
 *
 * These lived in `admin.settings.tsx` until a second screen needed them. They
 * are here rather than imported from that route module for a build reason, not
 * a tidiness one: React Router strips only `loader`/`action`/`headers`/
 * `middleware` from a route's client bundle, so importing `admin.settings.tsx`
 * from another route would drag `client.server`, `auth.server` and
 * `event.server` into the CLIENT graph — `npm run check` stays green and
 * `npm run build` fails. The same trap is documented at length on
 * `safeAdminRedirect` in `app/lib/event.server.ts`.
 *
 * Nothing in this module may import a `.server` file, for exactly that reason.
 */

/** Slugs go in URLs — lowercase, alphanumeric, single hyphens, no leading/trailing. */
export function normalizeSlug(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Convert a stored event date to the value expected by an HTML date input. */
export function toDateInput(value: Date | null): string {
  return value ? new Date(value).toISOString().slice(0, 10) : "";
}

/** Parse an HTML date input at UTC midnight, matching event settings storage. */
export function fromDateInput(value: string): Date | null {
  if (!value) return null;
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * Can `Intl` format in this zone? Asked of `Intl` itself, not of a hardcoded
 * list, so the answer is the one the DISPLAY path will get: the same engine
 * that formats decides what is storable, and no list can go stale against it.
 * That admits the aliases people actually type — `US/Pacific`, `PST`,
 * `PST8PDT`, lowercase `utc` — and refuses `Pacific` and `GMT+2`.
 *
 * This is the write-side half of the fix documented on `formatDateRange`:
 * `events.timezone` reaches `Intl.DateTimeFormat` in the public home loader for
 * every listed event, and an unknown zone throws `RangeError` there.
 *
 * Only `RangeError` means "unknown zone". Anything else is a real fault and is
 * rethrown rather than reported to the organizer as a bad timezone.
 */
export function isValidTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat(undefined, { timeZone: value });
    return true;
  } catch (error) {
    if (error instanceof RangeError) return false;
    throw error;
  }
}

/** The message both event screens show for a zone `Intl` does not know. */
export function invalidTimeZoneMessage(value: string): string {
  return `"${value}" is not a timezone this server knows. Use an IANA name such as America/Los_Angeles.`;
}
