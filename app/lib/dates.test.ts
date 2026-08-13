/**
 * `formatDateRange` runs in the PUBLIC HOME loader, once per listed event, so
 * its failure mode is the whole front page rather than one card. This file
 * pins both halves of that: the strings valid zones produce today (unchanged),
 * and the degradation an unknown zone gets instead of a thrown `RangeError`.
 *
 * The zone list is asserted against `Intl` first. A test that fed
 * `formatDateRange` a string this build's ICU happens to accept would prove
 * nothing about the catch, so the "bad" inputs are shown to be genuinely bad
 * before they are used.
 */
import { describe, expect, it } from "vitest";

import { formatDateRange } from "./dates";

const START = new Date("2027-04-10T00:00:00Z");
const END = new Date("2027-04-12T00:00:00Z");
const NEXT_MONTH = new Date("2027-05-02T00:00:00Z");

const REJECTED_BY_INTL = ["Pacific", "GMT+2", "Los Angeles", "America/Nowhere"];
const ACCEPTED_BY_INTL = ["America/Los_Angeles", "US/Pacific", "PST", "UTC", "Europe/Amsterdam"];

describe("the fixtures are what this file claims they are", () => {
  it("CONTROL: the bad zones really do throw and the good ones really do not", () => {
    for (const zone of REJECTED_BY_INTL) {
      expect(() => new Intl.DateTimeFormat("en-US", { timeZone: zone }), zone).toThrow(RangeError);
    }
    for (const zone of ACCEPTED_BY_INTL) {
      expect(() => new Intl.DateTimeFormat("en-US", { timeZone: zone }), zone).not.toThrow();
    }
  });
});

describe("MUST STILL FIRE: valid zones format exactly as before", () => {
  it("renders a same-month range with one month name", () => {
    // Apr 9, not Apr 10: the row is stored at UTC midnight and rendered in the
    // event zone. That day shift is N4 in the pre-tag sweep and is NOT touched
    // here — this asserts the value the tree produces today so a "helpful"
    // change to the catch cannot move it silently.
    expect(formatDateRange(START, END, "America/Los_Angeles")).toBe("Apr 9–11, 2027");
    expect(formatDateRange(START, END, "US/Pacific")).toBe("Apr 9–11, 2027");
    expect(formatDateRange(START, END, "PST")).toBe("Apr 9–11, 2027");
    expect(formatDateRange(START, END, "UTC")).toBe("Apr 10–12, 2027");
  });

  it("renders a single date, and a cross-month range with both months", () => {
    expect(formatDateRange(START, null, "UTC")).toBe("Apr 10, 2027");
    expect(formatDateRange(START, START, "UTC")).toBe("Apr 10, 2027");
    expect(formatDateRange(START, NEXT_MONTH, "UTC")).toBe("Apr 10 – May 2, 2027");
  });

  it("still returns null when there is no start date at all", () => {
    expect(formatDateRange(null, END, "UTC")).toBeNull();
  });
});

describe("an unknown zone degrades to no dates instead of a 500", () => {
  it("MUST FIRE: every zone Intl rejects returns null rather than throwing", () => {
    // Red on the unfixed tree: each of these threw RangeError out of the
    // public home loader and served the root ErrorBoundary to every visitor.
    for (const zone of REJECTED_BY_INTL) {
      expect(() => formatDateRange(START, END, zone), zone).not.toThrow();
      expect(formatDateRange(START, END, zone), zone).toBeNull();
    }
  });

  it("MUST FIRE: a single-date event with a bad zone degrades too", () => {
    // The `!endsOn` branch formats through a different call than the range
    // branch. A catch that only wrapped the range would pass the test above.
    expect(formatDateRange(START, null, "Pacific")).toBeNull();
    expect(formatDateRange(START, START, "Pacific")).toBeNull();
  });

  it("MUST NOT FIRE: the catch swallows RangeError only", () => {
    // A bare `catch { return null }` would turn any future bug in this
    // function into a silently missing date. Prove the guard is narrow by
    // making a non-RangeError escape from inside the formatter.
    const exploding = new Date(START) as Date & { getTime(): number };
    const boom = new TypeError("not a range problem");
    exploding.getTime = () => {
      throw boom;
    };
    expect(() => formatDateRange(exploding, END, "UTC")).toThrow(boom);
  });
});
