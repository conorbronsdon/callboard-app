/**
 * Day/slot arithmetic. The interesting cases are all timezone ones: an evening
 * session in Los Angeles is the NEXT day in UTC, and getting that wrong puts a
 * 5 PM keynote on the wrong column of the Day board.
 */
import { describe, expect, it } from "vitest";

import {
  DEFAULT_SLOT_MINUTES,
  dayKeyOf,
  durationMinutes,
  eventDays,
  formatDayLabel,
  formatRangeLabel,
  isDayKey,
  isTimeKey,
  isoWeekOf,
  parseSlotId,
  slotEpoch,
  slotForTime,
  slotId,
  slotTimes,
  timeKeyOf,
} from "./schedule";

const LA = "America/Los_Angeles";
const UTC = "UTC";

describe("dayKeyOf / timeKeyOf", () => {
  it("buckets an evening LA session onto the LA day, not the UTC one", () => {
    // 2026-10-08T02:00Z is 2026-10-07 19:00 in Los Angeles.
    const epoch = Date.UTC(2026, 9, 8, 2, 0);
    expect(dayKeyOf(epoch, UTC)).toBe("2026-10-08");
    expect(dayKeyOf(epoch, LA)).toBe("2026-10-07");
    expect(timeKeyOf(epoch, LA)).toBe("19:00");
  });

  it("round-trips through slotEpoch", () => {
    const epoch = slotEpoch("2026-10-07", "14:30", LA);
    expect(epoch).not.toBeNull();
    expect(dayKeyOf(epoch as number, LA)).toBe("2026-10-07");
    expect(timeKeyOf(epoch as number, LA)).toBe("14:30");
    // 2:30 PM PDT is 21:30 UTC
    expect(new Date(epoch as number).toISOString()).toBe("2026-10-07T21:30:00.000Z");
  });

  it("rejects malformed day/time input rather than inventing an instant", () => {
    expect(slotEpoch("2026-10-7", "14:30", LA)).toBeNull();
    expect(slotEpoch("2026-10-07", "2:30", LA)).toBeNull();
    expect(slotEpoch("2026-10-07", "24:00", LA)).toBeNull();
    expect(slotEpoch("nonsense", "14:30", LA)).toBeNull();
  });

  it("validates keys", () => {
    expect(isDayKey("2026-10-07")).toBe(true);
    expect(isDayKey("2026-1-7")).toBe(false);
    expect(isTimeKey("00:00")).toBe(true);
    expect(isTimeKey("23:59")).toBe(true);
    expect(isTimeKey("24:00")).toBe(false);
    expect(isTimeKey("12:60")).toBe(false);
  });
});

describe("eventDays", () => {
  const starts = Date.UTC(2026, 9, 7, 12);
  const ends = Date.UTC(2026, 9, 9, 12);

  it("lists every day of the declared range, inclusive", () => {
    expect(eventDays(starts, ends, [], LA)).toEqual([
      "2026-10-07",
      "2026-10-08",
      "2026-10-09",
    ]);
  });

  it("is a single day when start and end coincide", () => {
    expect(eventDays(starts, starts, [], LA)).toEqual(["2026-10-07"]);
  });

  it("unions in a day that only a stray session lives on", () => {
    const stray = Date.UTC(2026, 9, 12, 18);
    expect(eventDays(starts, ends, [stray], LA)).toEqual([
      "2026-10-07",
      "2026-10-08",
      "2026-10-09",
      "2026-10-12",
    ]);
  });

  it("falls back to the scheduled sessions when the event has no dates", () => {
    expect(eventDays(null, null, [Date.UTC(2026, 9, 7, 18)], LA)).toEqual(["2026-10-07"]);
  });

  it("returns nothing when there is neither a range nor a session", () => {
    expect(eventDays(null, null, [], LA)).toEqual([]);
  });

  it("crosses a DST fall-back without duplicating or skipping a day", () => {
    // US DST ends 2026-11-01. Range spans it.
    const before = Date.UTC(2026, 9, 31, 12);
    const after = Date.UTC(2026, 10, 2, 12);
    expect(eventDays(before, after, [], LA)).toEqual([
      "2026-10-31",
      "2026-11-01",
      "2026-11-02",
    ]);
  });

  it("accepts Date objects as well as epochs", () => {
    expect(eventDays(new Date(starts), new Date(ends), [new Date(starts)], LA)).toEqual([
      "2026-10-07",
      "2026-10-08",
      "2026-10-09",
    ]);
  });
});

describe("isoWeekOf", () => {
  it("puts the days of one conference in one bucket", () => {
    expect(isoWeekOf("2026-10-07")).toBe(isoWeekOf("2026-10-09"));
  });

  it("splits across a week boundary", () => {
    // 2026-10-11 is a Sunday, 2026-10-12 a Monday.
    expect(isoWeekOf("2026-10-11")).not.toBe(isoWeekOf("2026-10-12"));
  });

  it("computes a known week number", () => {
    expect(isoWeekOf("2026-01-01")).toBe("2026-W01");
  });
});

describe("slot grid", () => {
  it("produces half-hour rows across the day window", () => {
    const times = slotTimes();
    expect(times[0]).toBe("08:00");
    expect(times[1]).toBe("08:30");
    expect(times.at(-1)).toBe("19:30");
    expect(times).toHaveLength(((20 - 8) * 60) / DEFAULT_SLOT_MINUTES);
  });

  it("honours a custom step and window", () => {
    expect(slotTimes(60, 9, 12)).toEqual(["09:00", "10:00", "11:00"]);
  });

  it("snaps a session DOWN to the slot it starts in", () => {
    const times = slotTimes();
    expect(slotForTime("14:00", times)).toBe("14:00");
    expect(slotForTime("14:45", times)).toBe("14:30");
    expect(slotForTime("19:59", times)).toBe("19:30");
  });

  it("returns null for a time before the first slot", () => {
    expect(slotForTime("07:59", slotTimes())).toBeNull();
  });

  it("returns null for junk", () => {
    expect(slotForTime("nope", slotTimes())).toBeNull();
    expect(slotForTime("10:00", [])).toBeNull();
  });
});

describe("slot ids", () => {
  it("round-trips", () => {
    const id = slotId("room-1", "2026-10-07", "14:30");
    expect(id).toBe("slot|room-1|2026-10-07|14:30");
    expect(parseSlotId(id)).toEqual({
      roomId: "room-1",
      day: "2026-10-07",
      time: "14:30",
    });
  });

  it("rejects anything that is not a slot id", () => {
    expect(parseSlotId("tray")).toBeNull();
    expect(parseSlotId("slot|room-1|2026-10-07")).toBeNull();
    expect(parseSlotId("slot||2026-10-07|14:30")).toBeNull();
    expect(parseSlotId("slot|room-1|bad-day|14:30")).toBeNull();
    expect(parseSlotId("slot|room-1|2026-10-07|25:00")).toBeNull();
  });
});

describe("labels and duration", () => {
  it("formats a day heading in the event zone", () => {
    expect(formatDayLabel("2026-10-07", LA)).toBe("Wed, Oct 7, 2026");
  });

  it("formats a time range, and says so when unscheduled", () => {
    const start = slotEpoch("2026-10-07", "14:30", LA) as number;
    const end = start + 30 * 60_000;
    expect(formatRangeLabel(start, end, LA)).toBe("2:30 PM – 3:00 PM");
    expect(formatRangeLabel(start, null, LA)).toBe("2:30 PM");
    expect(formatRangeLabel(null, null, LA)).toBe("Unscheduled");
  });

  it("computes duration, and refuses inverted or missing ends", () => {
    const start = Date.UTC(2026, 9, 7, 17);
    expect(durationMinutes(start, start + 45 * 60_000)).toBe(45);
    expect(durationMinutes(start, null)).toBeNull();
    expect(durationMinutes(null, start)).toBeNull();
    expect(durationMinutes(start, start)).toBeNull();
    expect(durationMinutes(start, start - 60_000)).toBeNull();
  });
});
