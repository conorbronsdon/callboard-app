import { describe, expect, it } from "vitest";

import { DEFAULT_PUBLIC_SESSION_MINUTES } from "~/lib/agenda/schedule-ics";
import { buildCalendarDeeplinks } from "./calendar-deeplinks";

const start = new Date("2026-10-07T15:05:09-07:00");

describe("buildCalendarDeeplinks", () => {
  it("MUST FIRE: converts provider dates to UTC in each provider's required format", () => {
    const links = buildCalendarDeeplinks({
      title: "Agent reliability",
      description: "Practical techniques",
      location: "Main Stage",
      start,
      end: new Date("2026-10-07T16:05:09-07:00"),
    });

    const google = new URL(links.google);
    expect(google.searchParams.get("dates")).toBe("20261007T220509Z/20261007T230509Z");
    const outlook = new URL(links.outlook);
    expect(outlook.searchParams.get("startdt")).toBe("2026-10-07T22:05:09.000Z");
    expect(outlook.searchParams.get("enddt")).toBe("2026-10-07T23:05:09.000Z");
  });

  it("MUST FIRE: URL-encodes spaces, ampersands, and unicode without splitting fields", () => {
    const links = buildCalendarDeeplinks({
      title: "R&D for agents ☃",
      description: "Measure & improve",
      location: "Hall A & B — North",
      start,
      end: null,
    });

    for (const href of [links.google, links.outlook]) {
      expect(href).toContain("%26");
      expect(href).toContain("%E2%98%83");
      expect(href).not.toContain("R&D");
      expect(href).not.toContain("Hall A & B");
    }
    expect(new URL(links.google).searchParams.get("text")).toBe("R&D for agents ☃");
    expect(new URL(links.google).searchParams.get("location")).toBe("Hall A & B — North");
    expect(new URL(links.outlook).searchParams.get("subject")).toBe("R&D for agents ☃");
    expect(new URL(links.outlook).searchParams.get("location")).toBe("Hall A & B — North");
  });

  it("uses the shared public-calendar fallback when no explicit end exists", () => {
    const links = buildCalendarDeeplinks({
      title: "Fallback duration",
      description: null,
      location: null,
      start,
      end: null,
    });
    const expectedEnd = new Date(
      start.getTime() + DEFAULT_PUBLIC_SESSION_MINUTES * 60_000,
    ).toISOString();

    expect(new URL(links.outlook).searchParams.get("enddt")).toBe(expectedEnd);
  });

  it("MUST NOT FIRE: an explicit end is preserved instead of applying the fallback", () => {
    const explicitEnd = new Date("2026-10-07T22:42:00Z");
    const links = buildCalendarDeeplinks({
      title: "Explicit duration",
      description: null,
      location: null,
      start,
      end: explicitEnd,
    });

    expect(new URL(links.outlook).searchParams.get("enddt")).toBe(explicitEnd.toISOString());
  });
});
