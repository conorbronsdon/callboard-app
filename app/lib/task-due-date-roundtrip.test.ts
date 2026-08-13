/**
 * SPK-05 / CNT-01 — "task due dates render +1 day everywhere".
 *
 * The same class as N4 in issue #67, and the write path is NOT the culprit here.
 * `admin.tasks.tsx` already stores the due date correctly: it anchors the typed
 * `YYYY-MM-DD` to 23:59 in the EVENT's timezone via `zonedInputToEpoch`, exactly
 * as the CFP close date, the edit deadline, the review-round dates and the
 * agenda slots all do.
 *
 * The render was the bug. `formatDueDate` hardcoded `timeZone: "UTC"`, so an
 * organizer in Los Angeles who typed `2027-04-01` stored `2027-04-02T06:59Z` and
 * every screen read that epoch back in UTC and said **Apr 2**. The reminder
 * email for the very same row said **Apr 1**, because email copy went through
 * `formatDue(epoch, timeZone)` and was zone-correct all along. One task, one
 * epoch, two different days depending on which surface you looked at.
 *
 * Only negative-offset zones are wrong — every organizer in the Americas, and
 * nobody in Europe or Asia-Pacific. That asymmetry is why it survived casual
 * testing, and it is why the CONTROL below exists: a fixture in Amsterdam would
 * pass against the broken code and prove nothing.
 *
 * The old UTC hardcode had a real reason — SSR and hydration must agree on the
 * string. Passing an explicit zone keeps that: the zone is loader data computed
 * on the server, not `Intl.DateTimeFormat().resolvedOptions().timeZone` read off
 * the browser, so both renders format the same epoch in the same zone.
 */
import { describe, expect, it } from "vitest";

import { formatDue } from "~/lib/comms/reminders";
import { formatDueDate } from "~/lib/portal-progress";
import { zonedInputToEpoch } from "~/lib/zoned-time";

/** The organizer types this into `<input type="date" name="dueOn">`. */
const TYPED = "2027-04-01";

/** Exactly what `admin.tasks.tsx` does with it. */
function store(typed: string, timeZone: string): number {
  const epoch = zonedInputToEpoch(`${typed}T23:59`, timeZone);
  if (epoch === null) throw new Error(`fixture zone is unusable: ${timeZone}`);
  return epoch;
}

/**
 * Zones whose 23:59 anchor lands on the NEXT UTC day. These are the ones that
 * rendered a day late, and the only ones that can catch a regression.
 */
const SHIFTING = ["America/Los_Angeles", "America/New_York", "America/Chicago"];

/** Zones already ahead of UTC at 23:59 — these read correctly even when broken. */
const NON_SHIFTING = ["Europe/Amsterdam", "Asia/Tokyo", "UTC"];

describe("the fixture is discriminating", () => {
  it("CONTROL: the shifting zones really do cross the UTC date line, the others really do not", () => {
    // Without this, a "fix" that changed nothing would still show green in the
    // NON_SHIFTING block and the suite would be decorative.
    const utcDay = (epoch: number) => new Date(epoch).toISOString().slice(0, 10);

    for (const zone of SHIFTING) {
      expect(utcDay(store(TYPED, zone)), zone).toBe("2027-04-02");
    }
    for (const zone of NON_SHIFTING) {
      expect(utcDay(store(TYPED, zone)), zone).toBe("2027-04-01");
    }
  });
});

describe("the date an organizer types is the date every surface shows", () => {
  it("must fire: a due date typed in a negative-offset zone renders as the typed day", () => {
    for (const zone of SHIFTING) {
      expect(formatDueDate(store(TYPED, zone), zone), zone).toBe("Apr 1");
    }
  });

  it("must NOT fire: zones that were already correct stay correct", () => {
    for (const zone of NON_SHIFTING) {
      expect(formatDueDate(store(TYPED, zone), zone), zone).toBe("Apr 1");
    }
  });

  it("must fire: the screen and the reminder email name the SAME day", () => {
    // The two renderers disagreeing is the defect a speaker actually reported:
    // the portal said one day, the email that nagged them said another.
    for (const zone of [...SHIFTING, ...NON_SHIFTING]) {
      const epoch = store(TYPED, zone);
      expect(formatDue(epoch, zone), zone).toContain(formatDueDate(epoch, zone));
    }
  });

  it("must NOT fire: the zone is honoured, not ignored — one epoch, two zones, two days", () => {
    // A fix that simply swapped one hardcoded zone for another would pass every
    // assertion above. This one refuses that: the same instant is genuinely a
    // different calendar day in Auckland and in Los Angeles.
    const instant = Date.UTC(2027, 3, 1, 6, 59);
    expect(formatDueDate(instant, "America/Los_Angeles")).toBe("Mar 31");
    expect(formatDueDate(instant, "Pacific/Auckland")).toBe("Apr 1");
  });
});
