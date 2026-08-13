/**
 * Date display shared by the public surfaces.
 *
 * `formatDateRange` lived in `public.event.tsx`. `public.home.tsx` now needs
 * the same string, and the two obvious shortcuts are both wrong: copying the
 * function makes a derived copy that will drift the first time either page
 * changes its format, and importing it from `public.event.tsx` makes a route
 * import a route — which in React Router + Vite drags that route's
 * `.server` imports (`~/db/client.server` here) toward the client bundle.
 *
 * So it lives here, in a module with no server imports at all, and both routes
 * read it.
 */

/**
 * "Oct 7-9, 2026", collapsing a same-month range rather than repeating the
 * month, and degrading to a single date when there is no end. Formatted in the
 * event's timezone: an event that starts on the 7th in Los Angeles must not
 * display as the 8th because the Worker runs in UTC.
 *
 * ── Why the try/catch ───────────────────────────────────────────────────────
 * `events.timezone` is free text typed by an organizer, and `Intl` throws
 * `RangeError` on a zone it does not know ("Pacific", "GMT+2"). This function
 * is called in the PUBLIC HOME loader, once per listed event, so one bad row
 * would take the whole event list to the root ErrorBoundary — a 500 on the
 * front page for every visitor, not just a broken card on one event's page.
 *
 * A dateless card is a degradation an organizer can see and fix. A 500 is not.
 * The write screens validate the field (`isValidTimeZone` in `event-form.ts`),
 * which is the real fix; this is the seatbelt for the rows already stored, for
 * a value written by a migration or by hand, and for an ICU build that knows
 * fewer zones than the machine the row was created on.
 *
 * Only `RangeError` is swallowed. Anything else rethrows — a catch-all here
 * would hide real bugs behind a missing date.
 */
export function formatDateRange(
  startsOn: Date | null,
  endsOn: Date | null,
  timeZone: string,
): string | null {
  if (!startsOn) return null;
  try {
    return formatInZone(startsOn, endsOn, timeZone);
  } catch (error) {
    if (error instanceof RangeError) return null;
    throw error;
  }
}

function formatInZone(startsOn: Date, endsOn: Date | null, timeZone: string): string {
  const day = (date: Date, withYear: boolean) =>
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      month: "short",
      day: "numeric",
      ...(withYear ? { year: "numeric" as const } : {}),
    }).format(date);

  if (!endsOn || startsOn.getTime() === endsOn.getTime()) return day(startsOn, true);

  const monthAndYear = (date: Date) =>
    new Intl.DateTimeFormat("en-US", { timeZone, month: "short", year: "numeric" }).format(date);

  if (monthAndYear(startsOn) === monthAndYear(endsOn)) {
    const endDay = new Intl.DateTimeFormat("en-US", { timeZone, day: "numeric" }).format(endsOn);
    const year = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric" }).format(endsOn);
    return `${day(startsOn, false)}–${endDay}, ${year}`;
  }
  return `${day(startsOn, false)} – ${day(endsOn, true)}`;
}
