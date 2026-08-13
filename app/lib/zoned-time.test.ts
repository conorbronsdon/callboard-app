import { describe, expect, it } from "vitest";

import { epochToZonedInput, formatInZone, zonedInputToEpoch } from "./zoned-time";

const LA = "America/Los_Angeles";

describe("zonedInputToEpoch", () => {
  it("reads a wall-clock time as the EVENT's timezone, not UTC", () => {
    // Sep 15 2026 23:59 in Los Angeles is PDT (UTC-7) => 06:59 UTC on Sep 16.
    const epoch = zonedInputToEpoch("2026-09-15T23:59", LA);
    expect(new Date(epoch!).toISOString()).toBe("2026-09-16T06:59:00.000Z");

    // The bug this guards: parsing as UTC would land 7 hours early.
    expect(epoch).not.toBe(Date.parse("2026-09-15T23:59:00Z"));
  });

  it("uses the standard offset on the winter side of the DST boundary", () => {
    // Jan 15 is PST (UTC-8).
    expect(new Date(zonedInputToEpoch("2026-01-15T12:00", LA)!).toISOString()).toBe(
      "2026-01-15T20:00:00.000Z",
    );
  });

  it("is a no-op for UTC", () => {
    expect(new Date(zonedInputToEpoch("2026-09-15T23:59", "UTC")!).toISOString()).toBe(
      "2026-09-15T23:59:00.000Z",
    );
  });

  it("returns null for empty or unparseable input", () => {
    expect(zonedInputToEpoch("", LA)).toBeNull();
    expect(zonedInputToEpoch("not-a-date", LA)).toBeNull();
  });
});

describe("epochToZonedInput", () => {
  it("round-trips a value back into the input box unchanged", () => {
    for (const value of ["2026-09-15T23:59", "2026-01-15T12:00", "2026-03-08T04:30"]) {
      expect(epochToZonedInput(zonedInputToEpoch(value, LA), LA)).toBe(value);
    }
  });

  it("accepts a Date as well as an epoch, and blanks null", () => {
    const epoch = zonedInputToEpoch("2026-09-15T23:59", LA)!;
    expect(epochToZonedInput(new Date(epoch), LA)).toBe("2026-09-15T23:59");
    expect(epochToZonedInput(null, LA)).toBe("");
    expect(epochToZonedInput(undefined, LA)).toBe("");
  });
});

describe("formatInZone", () => {
  it("renders the deadline prose with the zone abbreviation", () => {
    const epoch = zonedInputToEpoch("2026-09-15T23:59", LA)!;
    const text = formatInZone(epoch, LA)!;
    expect(text).toContain("September 15");
    expect(text).toContain("11:59");
    expect(text).toContain("PDT");
  });

  it("shows the SAME instant differently in another zone (proves the zone is used)", () => {
    const epoch = zonedInputToEpoch("2026-09-15T23:59", LA)!;
    expect(formatInZone(epoch, "America/New_York")).toContain("September 16");
  });

  it("returns null when there is no date", () => {
    expect(formatInZone(null, LA)).toBeNull();
  });
});
