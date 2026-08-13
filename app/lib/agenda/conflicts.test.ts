/**
 * Conflict detection: must-fire AND must-not-fire, per AGENTS.md §2.
 *
 * The must-NOT-fire cases are the ones that matter. A detector that flags
 * everything "finds" every real conflict and is worthless, so every carve-out
 * (adjacent, different day, different room, unscheduled, no room) gets a test
 * sitting next to the positive case it complements.
 */
import { describe, expect, it } from "vitest";

import {
  CONFLICT_SEVERITY,
  advisoryConflicts,
  blockingConflicts,
  conflictLabel,
  conflictedSessionIds,
  conflictsBySession,
  findConflicts,
  findRoomConflicts,
  findSpeakerConflicts,
  findTrackConflicts,
  intervalsOverlap,
  isBlocking,
  isScheduled,
  severityOf,
  type AgendaEntry,
} from "./conflicts";

/** 2026-10-07 in UTC; the detector only ever sees epochs. */
const DAY1 = Date.UTC(2026, 9, 7);
const DAY2 = Date.UTC(2026, 9, 8);
const HOUR = 3_600_000;
const MIN = 60_000;

const ROOM_A = "room-main";
const ROOM_B = "room-workshop";

let counter = 0;
function entry(over: Partial<AgendaEntry> & { startsAt?: number | null }): AgendaEntry {
  counter += 1;
  return {
    id: over.id ?? `s${counter}`,
    title: over.title ?? `Session ${counter}`,
    startsAt: over.startsAt ?? null,
    endsAt: over.endsAt ?? null,
    roomId: over.roomId ?? null,
    roomName: over.roomName ?? null,
    trackId: over.trackId ?? null,
    trackName: over.trackName ?? null,
    participants: over.participants ?? [],
  };
}

/** `at(DAY1, 10, 60)` = a 60-minute session starting 10:00 on day 1. */
function at(day: number, hour: number, minutes: number, over: Partial<AgendaEntry> = {}) {
  const startsAt = day + hour * HOUR;
  return entry({ ...over, startsAt, endsAt: startsAt + minutes * MIN });
}

describe("intervalsOverlap", () => {
  it("must fire on a genuine overlap", () => {
    expect(intervalsOverlap(0, 100, 50, 150)).toBe(true);
    expect(intervalsOverlap(50, 150, 0, 100)).toBe(true);
    // fully contained
    expect(intervalsOverlap(0, 100, 25, 75)).toBe(true);
    // identical
    expect(intervalsOverlap(0, 100, 0, 100)).toBe(true);
  });

  it("must NOT fire on adjacency — back-to-back is the normal case", () => {
    expect(intervalsOverlap(0, 100, 100, 200)).toBe(false);
    expect(intervalsOverlap(100, 200, 0, 100)).toBe(false);
  });

  it("must NOT fire on a gap", () => {
    expect(intervalsOverlap(0, 100, 101, 200)).toBe(false);
  });
});

describe("isScheduled", () => {
  it("accepts a real interval and rejects the half-entered ones", () => {
    expect(isScheduled(at(DAY1, 10, 30))).toBe(true);
    expect(isScheduled(entry({ startsAt: DAY1, endsAt: null }))).toBe(false);
    expect(isScheduled(entry({ startsAt: null, endsAt: DAY1 }))).toBe(false);
    // zero-length and inverted occupy no time
    expect(isScheduled(entry({ startsAt: DAY1, endsAt: DAY1 }))).toBe(false);
    expect(isScheduled(entry({ startsAt: DAY1 + HOUR, endsAt: DAY1 }))).toBe(false);
  });
});

describe("findRoomConflicts", () => {
  it("MUST FIRE: same room, overlapping times", () => {
    const a = at(DAY1, 10, 60, { id: "a", title: "Talk A", roomId: ROOM_A, roomName: "Main Stage" });
    const b = at(DAY1, 10, 60, { id: "b", title: "Talk B", roomId: ROOM_A, roomName: "Main Stage" });
    b.startsAt = DAY1 + 10 * HOUR + 30 * MIN;
    b.endsAt = (b.startsAt as number) + 60 * MIN;

    const found = findRoomConflicts([a, b]);
    expect(found).toHaveLength(1);
    expect(found[0].kind).toBe("room");
    expect(found[0].resourceId).toBe(ROOM_A);
    expect(found[0].resourceName).toBe("Main Stage");
    expect(found[0].a.id).toBe("a");
    expect(found[0].b.id).toBe("b");
    expect(found[0].overlapMinutes).toBe(30);
    expect(conflictLabel(found[0])).toBe("Room double-booked · Main Stage");
  });

  it("MUST NOT FIRE: adjacent, back-to-back sessions in the same room", () => {
    const a = at(DAY1, 10, 60, { id: "a", roomId: ROOM_A });
    const b = at(DAY1, 11, 60, { id: "b", roomId: ROOM_A });
    expect(findRoomConflicts([a, b])).toEqual([]);
  });

  it("MUST NOT FIRE: same room, same clock time, DIFFERENT day", () => {
    const a = at(DAY1, 10, 60, { id: "a", roomId: ROOM_A });
    const b = at(DAY2, 10, 60, { id: "b", roomId: ROOM_A });
    expect(findRoomConflicts([a, b])).toEqual([]);
  });

  it("MUST NOT FIRE: overlapping times in DIFFERENT rooms", () => {
    const a = at(DAY1, 10, 60, { id: "a", roomId: ROOM_A });
    const b = at(DAY1, 10, 60, { id: "b", roomId: ROOM_B });
    expect(findRoomConflicts([a, b])).toEqual([]);
  });

  it("MUST NOT FIRE: overlapping sessions with NO room assigned", () => {
    const a = at(DAY1, 10, 60, { id: "a", roomId: null });
    const b = at(DAY1, 10, 60, { id: "b", roomId: null });
    expect(findRoomConflicts([a, b])).toEqual([]);
  });

  it("MUST NOT FIRE: an unscheduled session cannot clash with anything", () => {
    const a = at(DAY1, 10, 60, { id: "a", roomId: ROOM_A });
    const b = entry({ id: "b", roomId: ROOM_A, startsAt: null, endsAt: null });
    expect(findRoomConflicts([a, b])).toEqual([]);
  });

  it("reports every pair when three sessions pile onto one room", () => {
    const a = at(DAY1, 10, 120, { id: "a", roomId: ROOM_A });
    const b = at(DAY1, 10, 120, { id: "b", roomId: ROOM_A });
    const c = at(DAY1, 11, 30, { id: "c", roomId: ROOM_A });
    const found = findRoomConflicts([a, b, c]);
    expect(found.map((x) => `${x.a.id}-${x.b.id}`).sort()).toEqual(["a-b", "a-c", "b-c"]);
  });
});

describe("findRoomConflicts — multi-day boundaries", () => {
  it("MUST FIRE: a session running past midnight overlaps the next morning's", () => {
    const late = entry({
      id: "late",
      roomId: ROOM_A,
      roomName: "Main Stage",
      startsAt: DAY1 + 23 * HOUR + 30 * MIN,
      endsAt: DAY2 + 30 * MIN, // 23:30 → 00:30
    });
    const early = entry({
      id: "early",
      roomId: ROOM_A,
      roomName: "Main Stage",
      startsAt: DAY2,
      endsAt: DAY2 + HOUR, // 00:00 → 01:00
    });

    const found = findRoomConflicts([late, early]);
    expect(found).toHaveLength(1);
    expect(found[0].a.id).toBe("late");
    expect(found[0].b.id).toBe("early");
    expect(found[0].overlapMinutes).toBe(30);
  });

  it("MUST NOT FIRE: a session ending exactly at midnight and one starting there", () => {
    const late = entry({
      id: "late",
      roomId: ROOM_A,
      startsAt: DAY1 + 23 * HOUR,
      endsAt: DAY2, // ends AT midnight
    });
    const early = entry({
      id: "early",
      roomId: ROOM_A,
      startsAt: DAY2, // starts AT midnight
      endsAt: DAY2 + HOUR,
    });
    expect(findRoomConflicts([late, early])).toEqual([]);
  });

  it("MUST NOT FIRE: a 3-day event with one session per day in the same room", () => {
    const days = [DAY1, DAY2, DAY2 + 24 * HOUR];
    const entries = days.map((day, i) => at(day, 10, 60, { id: `d${i}`, roomId: ROOM_A }));
    expect(findRoomConflicts(entries)).toEqual([]);
  });
});

describe("findSpeakerConflicts", () => {
  const sam = { id: "p-sam", name: "Sam Speaker" };
  const rina = { id: "p-rina", name: "Rina Okafor" };

  it("MUST FIRE: one speaker in two overlapping sessions, different rooms", () => {
    const a = at(DAY1, 10, 60, {
      id: "a",
      title: "Talk A",
      roomId: ROOM_A,
      participants: [sam],
    });
    const b = at(DAY1, 10, 60, {
      id: "b",
      title: "Talk B",
      roomId: ROOM_B,
      participants: [sam, rina],
    });

    const found = findSpeakerConflicts([a, b]);
    expect(found).toHaveLength(1);
    expect(found[0].kind).toBe("speaker");
    expect(found[0].resourceId).toBe("p-sam");
    expect(conflictLabel(found[0])).toBe("Speaker double-booked · Sam Speaker");
    // …and no ROOM conflict, because the rooms differ.
    expect(findRoomConflicts([a, b])).toEqual([]);
  });

  it("MUST FIRE once per double-booked person", () => {
    const a = at(DAY1, 10, 60, { id: "a", roomId: ROOM_A, participants: [sam, rina] });
    const b = at(DAY1, 10, 60, { id: "b", roomId: ROOM_B, participants: [sam, rina] });
    const found = findSpeakerConflicts([a, b]);
    expect(found).toHaveLength(2);
    expect(found.map((x) => x.resourceId).sort()).toEqual(["p-rina", "p-sam"]);
  });

  it("MUST NOT FIRE: adjacent sessions for the same speaker", () => {
    const a = at(DAY1, 10, 60, { id: "a", roomId: ROOM_A, participants: [sam] });
    const b = at(DAY1, 11, 60, { id: "b", roomId: ROOM_B, participants: [sam] });
    expect(findSpeakerConflicts([a, b])).toEqual([]);
  });

  it("MUST NOT FIRE: different speakers overlapping", () => {
    const a = at(DAY1, 10, 60, { id: "a", roomId: ROOM_A, participants: [sam] });
    const b = at(DAY1, 10, 60, { id: "b", roomId: ROOM_B, participants: [rina] });
    expect(findSpeakerConflicts([a, b])).toEqual([]);
  });

  it("MUST NOT FIRE: same speaker, same clock time, different DAY", () => {
    const a = at(DAY1, 10, 60, { id: "a", roomId: ROOM_A, participants: [sam] });
    const b = at(DAY2, 10, 60, { id: "b", roomId: ROOM_B, participants: [sam] });
    expect(findSpeakerConflicts([a, b])).toEqual([]);
  });

  it("MUST NOT FIRE: sessions with no participants recorded", () => {
    const a = at(DAY1, 10, 60, { id: "a", roomId: ROOM_A, participants: [] });
    const b = at(DAY1, 10, 60, { id: "b", roomId: ROOM_B });
    expect(findSpeakerConflicts([a, b])).toEqual([]);
  });
});

describe("findTrackConflicts", () => {
  const TRACK_A = "track-agents";
  const TRACK_B = "track-evals";

  it("MUST FIRE: same track with overlapping times", () => {
    const a = at(DAY1, 10, 60, {
      id: "a",
      trackId: TRACK_A,
      trackName: "Agents",
    });
    const b = at(DAY1, 10, 60, {
      id: "b",
      trackId: TRACK_A,
      trackName: "Agents",
    });

    const found = findTrackConflicts([a, b]);
    expect(found).toHaveLength(1);
    expect(found[0].kind).toBe("track");
    expect(found[0].resourceId).toBe(TRACK_A);
    expect(found[0].resourceName).toBe("Agents");
    expect(found[0].overlapMinutes).toBe(60);
  });

  it("MUST NOT FIRE: overlapping sessions in different tracks", () => {
    const a = at(DAY1, 10, 60, { id: "a", trackId: TRACK_A });
    const b = at(DAY1, 10, 60, { id: "b", trackId: TRACK_B });
    expect(findTrackConflicts([a, b])).toEqual([]);
  });

  it("MUST NOT FIRE: null tracks are not a shared resource", () => {
    const a = at(DAY1, 10, 60, { id: "a", trackId: null });
    const b = at(DAY1, 10, 60, { id: "b", trackId: null });
    expect(findTrackConflicts([a, b])).toEqual([]);
  });

  it("MUST NOT FIRE: adjacent sessions in the same track", () => {
    const a = at(DAY1, 10, 60, { id: "a", trackId: TRACK_A });
    const b = at(DAY1, 11, 60, { id: "b", trackId: TRACK_A });
    expect(findTrackConflicts([a, b])).toEqual([]);
  });
});

describe("conflict severity and labels", () => {
  const room = findRoomConflicts([
    at(DAY1, 10, 60, { id: "room-a", roomId: ROOM_A, roomName: "Main Stage" }),
    at(DAY1, 10, 60, { id: "room-b", roomId: ROOM_A, roomName: "Main Stage" }),
  ])[0];
  const sam = { id: "p-sam", name: "Sam Speaker" };
  const speaker = findSpeakerConflicts([
    at(DAY1, 12, 60, { id: "speaker-a", participants: [sam] }),
    at(DAY1, 12, 60, { id: "speaker-b", participants: [sam] }),
  ])[0];
  const track = findTrackConflicts([
    at(DAY1, 14, 60, { id: "track-a", trackId: "track-ai", trackName: "AI Systems" }),
    at(DAY1, 14, 60, { id: "track-b", trackId: "track-ai", trackName: "AI Systems" }),
  ])[0];

  it("maps every conflict kind to its exact severity", () => {
    expect(CONFLICT_SEVERITY).toEqual({
      room: "blocking",
      speaker: "blocking",
      track: "advisory",
    });
    expect(severityOf(room)).toBe("blocking");
    expect(severityOf(speaker)).toBe("blocking");
    expect(severityOf(track)).toBe("advisory");
    expect(isBlocking(room)).toBe(true);
    expect(isBlocking(track)).toBe(false);
    expect(blockingConflicts([track, speaker, room])).toEqual([speaker, room]);
    expect(advisoryConflicts([room, track, speaker])).toEqual([track]);
  });

  it("labels all three conflict kinds exactly", () => {
    expect(conflictLabel(room)).toBe("Room double-booked · Main Stage");
    expect(conflictLabel(speaker)).toBe("Speaker double-booked · Sam Speaker");
    expect(conflictLabel(track)).toBe("Track overlap · AI Systems");
  });
});

describe("findConflicts", () => {
  const sam = { id: "p-sam", name: "Sam Speaker" };

  it("reports a room clash and a speaker clash for the same pair as two rows", () => {
    const a = at(DAY1, 10, 60, {
      id: "a",
      roomId: ROOM_A,
      roomName: "Main Stage",
      participants: [sam],
    });
    const b = at(DAY1, 10, 60, {
      id: "b",
      roomId: ROOM_A,
      roomName: "Main Stage",
      participants: [sam],
    });

    const found = findConflicts([a, b]);
    expect(found.map((x) => x.kind).sort()).toEqual(["room", "speaker"]);
  });

  it("returns nothing for a clean programme", () => {
    const entries = [
      at(DAY1, 9, 60, { id: "a", roomId: ROOM_A, participants: [sam] }),
      at(DAY1, 10, 60, { id: "b", roomId: ROOM_A, participants: [sam] }),
      at(DAY1, 9, 60, { id: "c", roomId: ROOM_B }),
      entry({ id: "d", roomId: ROOM_A }),
    ];
    expect(findConflicts(entries)).toEqual([]);
  });

  it("returns nothing for an empty programme", () => {
    expect(findConflicts([])).toEqual([]);
  });

  it("sorts by when the clash starts", () => {
    const early = [
      at(DAY1, 9, 60, { id: "e1", roomId: ROOM_A }),
      at(DAY1, 9, 60, { id: "e2", roomId: ROOM_A }),
    ];
    const late = [
      at(DAY1, 16, 60, { id: "l1", roomId: ROOM_B }),
      at(DAY1, 16, 60, { id: "l2", roomId: ROOM_B }),
    ];
    const found = findConflicts([...late, ...early]);
    expect(found.map((x) => x.a.id)).toEqual(["e1", "l1"]);
  });
});

describe("conflict indexes", () => {
  it("maps both sides of every conflict and collects the ids", () => {
    const a = at(DAY1, 10, 60, { id: "a", roomId: ROOM_A, roomName: "Main Stage" });
    const b = at(DAY1, 10, 60, { id: "b", roomId: ROOM_A, roomName: "Main Stage" });
    const c = at(DAY1, 10, 60, { id: "c", roomId: ROOM_B });

    const conflicts = findConflicts([a, b, c]);
    const index = conflictsBySession(conflicts);

    expect(index.get("a")).toHaveLength(1);
    expect(index.get("b")).toHaveLength(1);
    // must NOT fire: the session in the other room is clean
    expect(index.has("c")).toBe(false);
    expect([...conflictedSessionIds(conflicts)].sort()).toEqual(["a", "b"]);
  });
});
