import { describe, expect, it } from "vitest";

import { icsValues, parseIcs } from "~/lib/comms/ics";
import { buildScheduleIcs, scheduleEndDate } from "./schedule-ics";

describe("buildScheduleIcs", () => {
  it("MUST FIRE: builds two parsed events with exact calendar properties and CRLF", () => {
    const calendar = buildScheduleIcs({
      calendarName: "Frontier AI Summit 2026",
      dtstamp: new Date("2026-08-12T12:00:00Z"),
      events: [
        {
          uid: "a@example.test",
          start: new Date("2026-10-07T22:00:00Z"),
          end: new Date("2026-10-07T22:30:00Z"),
          summary: "Building reliable agents",
          description: "Description\n\nSpeakers: Sam Speaker (Demo Speaker, Company 0)",
          location: "Main Stage",
          url: "https://example.test/e/event/schedule/a",
        },
        {
          uid: "b@example.test",
          start: new Date("2026-10-07T23:00:00Z"),
          end: new Date("2026-10-08T00:00:00Z"),
          summary: "Evaluation systems",
          location: "Workshop Room 1",
        },
      ],
    });
    const properties = parseIcs(calendar);
    expect(icsValues(properties, "BEGIN").filter((value) => value === "VEVENT")).toHaveLength(2);
    expect(icsValues(properties, "SUMMARY")).toEqual([
      "Building reliable agents",
      "Evaluation systems",
    ]);
    expect(icsValues(properties, "DTSTART")).toEqual([
      "20261007T220000Z",
      "20261007T230000Z",
    ]);
    expect(icsValues(properties, "DTEND")).toEqual([
      "20261007T223000Z",
      "20261008T000000Z",
    ]);
    expect(icsValues(properties, "LOCATION")).toEqual(["Main Stage", "Workshop Room 1"]);
    expect(icsValues(properties, "METHOD")).toEqual(["PUBLISH"]);
    expect(calendar).toMatch(/\r\n$/);
    expect(calendar.replace(/\r\n/g, "")).not.toContain("\n");
  });

  it("MUST NOT FIRE: an empty event list remains a valid empty VCALENDAR", () => {
    const properties = parseIcs(
      buildScheduleIcs({
        calendarName: "Empty schedule",
        dtstamp: new Date("2026-08-12T12:00:00Z"),
        events: [],
      }),
    );
    expect(icsValues(properties, "BEGIN")).toEqual(["VCALENDAR"]);
    expect(icsValues(properties, "END")).toEqual(["VCALENDAR"]);
    expect(icsValues(properties, "SUMMARY")).toEqual([]);
  });

  it("defaults a missing end to exactly 60 minutes", () => {
    const start = new Date("2026-10-07T22:00:00Z");
    expect(scheduleEndDate(start, null).toISOString()).toBe("2026-10-07T23:00:00.000Z");
    const explicit = new Date("2026-10-07T22:30:00Z");
    expect(scheduleEndDate(start, explicit)).toBe(explicit);
  });
});
