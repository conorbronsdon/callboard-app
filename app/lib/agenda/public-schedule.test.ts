import { describe, expect, it } from "vitest";

import {
  EMPTY_FILTER,
  countSessions,
  facetsOf,
  filterDays,
  matchesQuery,
  parseScheduleFilter,
  parseStoredSchedule,
  pruneStoredSchedule,
  scheduleFilterQuery,
  serialiseStoredSchedule,
  speakerRole,
  type PublicDay,
  type PublicSlot,
} from "./public-schedule";

const slot = (overrides: Partial<PublicSlot> = {}): PublicSlot => ({
  id: "a",
  title: "Building reliable agents",
  description: "Full description",
  timeLabel: "3:00 PM – 3:30 PM",
  startsAtMs: Date.UTC(2026, 9, 7, 22),
  roomName: "Main Stage",
  trackName: "Agents",
  trackColor: "#329af0",
  formatName: "Talk",
  speakers: [{ personId: "p-sam", name: "Sam Speaker", title: "Demo Speaker", company: "Vectorly" }],
  ...overrides,
});

const days: PublicDay[] = [
  { day: "2026-10-07", label: "Wed, Oct 7, 2026", sessions: [slot()] },
  {
    day: "2026-10-08",
    label: "Thu, Oct 8, 2026",
    sessions: [
      slot({
        id: "b",
        title: "Practical evaluation systems",
        roomName: "Workshop Room 1",
        trackName: "Evals & Reliability",
        formatName: "Workshop",
        speakers: [{ personId: "p-rina", name: "Rina Okafor", title: "Engineer", company: "Company 1" }],
      }),
    ],
  },
];

describe("schedule filter encoding", () => {
  it("trims URL values and emits only non-empty fields", () => {
    const filter = parseScheduleFilter(
      new URLSearchParams("q=%20Speaker%20&track=Agents&day=2026-10-07"),
    );
    expect(filter).toEqual({
      q: "Speaker",
      track: "Agents",
      format: "",
      room: "",
      day: "2026-10-07",
    });
    expect(scheduleFilterQuery(filter)).toBe("q=Speaker&track=Agents&day=2026-10-07");
    expect(scheduleFilterQuery(EMPTY_FILTER)).toBe("");
  });
});

describe("search", () => {
  it("MUST FIRE: title words and a speaker surname narrow the session set", () => {
    const byTitle = filterDays(days, { ...EMPTY_FILTER, q: "evaluation" }, null);
    const bySurname = filterDays(days, { ...EMPTY_FILTER, q: "speaker" }, null);
    expect(byTitle.flatMap((day) => day.sessions).map((item) => item.id)).toEqual(["b"]);
    expect(countSessions(byTitle)).toBe(1);
    expect(bySurname.flatMap((day) => day.sessions).map((item) => item.id)).toEqual(["a"]);
    expect(countSessions(bySurname)).toBe(1);
    expect(matchesQuery(slot(), "BUILDING")).toBe(true);
  });

  it("MUST NOT FIRE: misses and company-only matches stay empty", () => {
    expect(countSessions(filterDays(days, { ...EMPTY_FILTER, q: "nope" }, null))).toBe(0);
    expect(countSessions(filterDays(days, { ...EMPTY_FILTER, q: "Vectorly" }, null))).toBe(0);
  });
});

describe("facets", () => {
  it("MUST FIRE: track, format and room filter exactly, with AND composition", () => {
    for (const filter of [
      { ...EMPTY_FILTER, track: "Agents" },
      { ...EMPTY_FILTER, format: "Talk" },
      { ...EMPTY_FILTER, room: "Main Stage" },
      { ...EMPTY_FILTER, track: "Agents", format: "Talk" },
    ]) {
      expect(filterDays(days, filter, null).flatMap((day) => day.sessions).map((item) => item.id)).toEqual(["a"]);
    }
  });

  it("MUST NOT FIRE: impossible facet values do not fall back to all sessions", () => {
    expect(filterDays(days, { ...EMPTY_FILTER, room: "Nowhere" }, null)).toEqual([]);
    expect(facetsOf(days)).toEqual({
      tracks: ["Agents", "Evals & Reliability"],
      formats: ["Talk", "Workshop"],
      rooms: ["Main Stage", "Workshop Room 1"],
    });
  });
});

describe("day navigation", () => {
  it("MUST FIRE: a known day selects it while the default retains every day", () => {
    expect(filterDays(days, EMPTY_FILTER, null).map((day) => day.day)).toEqual([
      "2026-10-07",
      "2026-10-08",
    ]);
    expect(filterDays(days, { ...EMPTY_FILTER, day: "2026-10-08" }, null).map((day) => day.day)).toEqual([
      "2026-10-08",
    ]);
  });

  it("MUST NOT FIRE: an unknown day is an empty selection, never All days", () => {
    expect(filterDays(days, { ...EMPTY_FILTER, day: "not-a-day" }, null)).toEqual([]);
  });
});

describe("personal schedule storage", () => {
  it("MUST FIRE: stored ids round-trip and starred filtering keeps exactly the set", () => {
    const encoded = serialiseStoredSchedule(["b", "a", "b"]);
    expect(parseStoredSchedule(encoded)).toEqual(["b", "a"]);
    expect(
      filterDays(days, EMPTY_FILTER, new Set(parseStoredSchedule(encoded)))
        .flatMap((day) => day.sessions)
        .map((item) => item.id),
    ).toEqual(["a", "b"]);
  });

  it("MUST NOT FIRE: corrupt/non-array values and unpublished ids cannot survive", () => {
    expect(parseStoredSchedule("{")).toEqual([]);
    expect(parseStoredSchedule('{"id":"a"}')).toEqual([]);
    expect(pruneStoredSchedule(["a", "removed"], new Set(["a", "b"]))).toEqual(["a"]);
  });
});

describe("speaker role", () => {
  it("omits empty punctuation and degrades to either available field", () => {
    expect(speakerRole({ personId: "p", name: "A", title: "Engineer", company: "Callboard" })).toBe("Engineer, Callboard");
    expect(speakerRole({ personId: "p", name: "A", title: "Engineer", company: null })).toBe("Engineer");
    expect(speakerRole({ personId: "p", name: "A", title: null, company: "Callboard" })).toBe("Callboard");
    expect(speakerRole({ personId: "p", name: "A", title: null, company: null })).toBeNull();
  });
});
