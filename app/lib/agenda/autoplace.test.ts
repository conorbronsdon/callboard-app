import { describe, expect, it } from "vitest";

import { findConflicts, type AgendaEntry } from "./conflicts";
import { planAutoPlacement } from "./autoplace";

const DAY = "2026-10-07";
const ZONE = "America/Los_Angeles";

function unscheduled(
  id: string,
  title: string,
  participants: { id: string; name: string }[] = [],
): AgendaEntry {
  return { id, title, startsAt: null, endsAt: null, roomId: null, participants };
}

function resultingEntries(entries: AgendaEntry[], plan: ReturnType<typeof planAutoPlacement>) {
  const byId = new Map(plan.placements.map((placement) => [placement.sessionId, placement]));
  return entries.map((entry) => {
    const placement = byId.get(entry.id);
    return placement ? { ...entry, ...placement } : entry;
  });
}

describe("planAutoPlacement", () => {
  it("must place two sessions into distinct clean room/time pairs", () => {
    const entries = [unscheduled("b", "Beta"), unscheduled("a", "Alpha")];
    const plan = planAutoPlacement({
      entries,
      rooms: [{ id: "room-a" }, { id: "room-b" }],
      days: [DAY],
      slots: ["09:00"],
      timeZone: ZONE,
      defaultDurationMinutes: 30,
    });

    expect(plan.placements.map((placement) => placement.sessionId)).toEqual(["a", "b"]);
    expect(
      new Set(
        plan.placements.map(
          (placement) => `${placement.roomId}:${placement.startsAt}:${placement.endsAt}`,
        ),
      ).size,
    ).toBe(2);
    expect(plan.unplaced).toEqual([]);
    expect(findConflicts(resultingEntries(entries, plan))).toEqual([]);
  });

  it("must return identical output for identical input", () => {
    const input = {
      entries: [unscheduled("b", "Same title"), unscheduled("a", "Same title")],
      rooms: [{ id: "room-a" }, { id: "room-b" }],
      days: ["2026-10-08", DAY],
      slots: ["09:30", "09:00"],
      timeZone: ZONE,
      defaultDurationMinutes: 30,
    } as const;

    const first = planAutoPlacement({
      ...input,
      entries: [...input.entries],
      rooms: [...input.rooms],
      days: [...input.days],
      slots: [...input.slots],
    });
    const second = planAutoPlacement({
      ...input,
      entries: [...input.entries],
      rooms: [...input.rooms],
      days: [...input.days],
      slots: [...input.slots],
    });
    expect(second).toEqual(first);
    expect(first.placements.map((placement) => placement.sessionId)).toEqual(["a", "b"]);
  });

  it("must place exactly one session when two candidates share a speaker in one slot", () => {
    const speaker = [{ id: "speaker", name: "Sam Speaker" }];
    const entries = [
      unscheduled("a", "Alpha", speaker),
      unscheduled("b", "Beta", speaker),
    ];
    const plan = planAutoPlacement({
      entries,
      rooms: [{ id: "room-a" }, { id: "room-b" }],
      days: [DAY],
      slots: ["09:00"],
      timeZone: ZONE,
      defaultDurationMinutes: 30,
    });

    expect(plan.placements).toHaveLength(1);
    expect(plan.placements[0].sessionId).toBe("a");
    expect(plan.unplaced).toEqual([{ sessionId: "b", title: "Beta" }]);
    expect(findConflicts(resultingEntries(entries, plan))).toEqual([]);
  });

  it("must not double-book a room occupied across the whole grid", () => {
    const occupied: AgendaEntry = {
      id: "occupied",
      title: "Existing keynote",
      roomId: "room-a",
      startsAt: Date.parse("2026-10-07T16:00:00.000Z"),
      endsAt: Date.parse("2026-10-07T17:00:00.000Z"),
    };
    const candidate = unscheduled("candidate", "Candidate");
    const plan = planAutoPlacement({
      entries: [occupied, candidate],
      rooms: [{ id: "room-a" }],
      days: [DAY],
      slots: ["09:00", "09:30"],
      timeZone: ZONE,
      defaultDurationMinutes: 30,
    });

    expect(plan.placements).toEqual([]);
    expect(plan.unplaced).toEqual([{ sessionId: "candidate", title: "Candidate" }]);
  });

  it("must never move a session that is already scheduled", () => {
    const scheduled: AgendaEntry = {
      id: "scheduled",
      title: "Already placed",
      roomId: "room-a",
      startsAt: Date.parse("2026-10-07T18:00:00.000Z"),
      endsAt: Date.parse("2026-10-07T18:30:00.000Z"),
    };
    const original = { ...scheduled };
    const plan = planAutoPlacement({
      entries: [scheduled],
      rooms: [{ id: "room-b" }],
      days: [DAY],
      slots: ["09:00"],
      timeZone: ZONE,
      defaultDurationMinutes: 30,
    });

    expect(plan).toEqual({ placements: [], unplaced: [] });
    expect(scheduled).toEqual(original);
  });
});
