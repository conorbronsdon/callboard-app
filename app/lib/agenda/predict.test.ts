/**
 * Pre-drop conflict prediction: what WOULD this placement collide with?
 *
 * Today the board writes the move and recomputes afterwards
 * (`admin.agenda.tsx`, the "Recomputed AFTER the write" comment on the schedule
 * intent). Prediction answers the same question BEFORE the write, which is what
 * lets a blocking class refuse a move instead of reporting it after the fact.
 *
 * The load-bearing carve-out is SELF-EXCLUSION. A prediction that appends the
 * proposed placement instead of REPLACING the session's current one reports the
 * session colliding with its own former slot — a conflict that always fires and
 * is never real. That is the mutation this file exists to catch, so
 * "move a session onto its own current slot" is a must-NOT-fire case.
 *
 * The last test is the important one: prediction must agree with the post-hoc
 * detector the product already trusts. Prediction is a second CALLER of
 * `findConflicts`, never a second implementation of it.
 */
import { describe, expect, it } from "vitest";

import { findConflicts, type AgendaEntry } from "./conflicts";
import { predictConflicts } from "./predict";

const DAY1 = Date.UTC(2026, 9, 7);
const HOUR = 3_600_000;
const MIN = 60_000;

const ROOM_A = "room-main";
const ROOM_B = "room-workshop";

const SAM = { id: "person-sam", name: "Sam Speaker" };
const RILEY = { id: "person-riley", name: "Riley Reviewer" };

/** `slot(10, 60)` = starts 10:00 on day 1, runs 60 minutes. */
function slot(hour: number, minutes: number) {
  const startsAt = DAY1 + hour * HOUR;
  return { startsAt, endsAt: startsAt + minutes * MIN };
}

function entry(
  id: string,
  hour: number | null,
  minutes: number,
  over: Partial<AgendaEntry> = {},
): AgendaEntry {
  const times = hour === null ? { startsAt: null, endsAt: null } : slot(hour, minutes);
  return {
    id,
    title: `Talk ${id}`,
    roomId: null,
    roomName: null,
    participants: [],
    ...times,
    ...over,
  };
}

/**
 * The programme every case below predicts against:
 *   fixed-a  10:00–11:00  Main Stage      Sam
 *   fixed-b  14:00–15:00  Workshop Room   Riley
 * plus `mover`, which starts unscheduled unless a case places it.
 */
function programme(mover: AgendaEntry): AgendaEntry[] {
  return [
    entry("fixed-a", 10, 60, { roomId: ROOM_A, roomName: "Main Stage", participants: [SAM] }),
    entry("fixed-b", 14, 60, {
      roomId: ROOM_B,
      roomName: "Workshop Room",
      participants: [RILEY],
    }),
    mover,
  ];
}

describe("predictConflicts — must fire", () => {
  it("names the exact room collision a proposed placement would create", () => {
    const mover = entry("mover", null, 60, { participants: [RILEY] });
    const found = predictConflicts(programme(mover), {
      sessionId: "mover",
      roomId: ROOM_A,
      ...slot(10, 30), // 10:00–10:30, inside fixed-a's 10:00–11:00
    });

    expect(found).toHaveLength(1);
    // Values, not shape: the resource, the pair, and the size of the overlap.
    expect(found[0].kind).toBe("room");
    expect(found[0].resourceId).toBe(ROOM_A);
    expect(found[0].resourceName).toBe("Main Stage");
    expect([found[0].a.id, found[0].b.id].sort()).toEqual(["fixed-a", "mover"]);
    expect(found[0].overlapMinutes).toBe(30);
  });

  it("names a speaker collision even when the room is free", () => {
    // Sam is on fixed-a at 10:00. Put the mover in a DIFFERENT room at 10:00
    // with Sam on it: the room is clean, the person is not.
    const mover = entry("mover", null, 60, { participants: [SAM] });
    const found = predictConflicts(programme(mover), {
      sessionId: "mover",
      roomId: ROOM_B,
      ...slot(10, 60),
    });

    expect(found).toHaveLength(1);
    expect(found[0].kind).toBe("speaker");
    expect(found[0].resourceId).toBe(SAM.id);
    expect(found[0].resourceName).toBe("Sam Speaker");
    expect(found[0].overlapMinutes).toBe(60);
  });

  it("reports BOTH problems when a placement double-books room and person at once", () => {
    const mover = entry("mover", null, 60, { participants: [SAM] });
    const found = predictConflicts(programme(mover), {
      sessionId: "mover",
      roomId: ROOM_A,
      ...slot(10, 60),
    });

    // Same pair, two different fixes (move the room vs. move the time).
    expect(found.map((c) => c.kind).sort()).toEqual(["room", "speaker"]);
  });
});

describe("predictConflicts — must NOT fire", () => {
  it("returns nothing for a genuinely clean slot", () => {
    const mover = entry("mover", null, 60, { participants: [SAM] });
    const found = predictConflicts(programme(mover), {
      sessionId: "mover",
      roomId: ROOM_B,
      ...slot(18, 60), // nobody is anywhere near 18:00
    });
    expect(found).toEqual([]);
  });

  it("SELF-EXCLUSION: re-dropping a session on its own current slot predicts nothing", () => {
    /*
     * The regression this pins. `mover` is ALREADY at 10:00 in Main Stage with
     * Sam. An implementation that appends the proposal instead of replacing the
     * existing row sees two sessions at 10:00 in Main Stage sharing Sam, and
     * reports a room AND a speaker conflict against itself — every time, for
     * every no-op move.
     */
    const mover = entry("mover", 10, 60, {
      roomId: ROOM_A,
      roomName: "Main Stage",
      participants: [SAM],
    });
    const found = predictConflicts(
      [
        entry("fixed-b", 14, 60, { roomId: ROOM_B, participants: [RILEY] }),
        mover,
      ],
      { sessionId: "mover", roomId: ROOM_A, ...slot(10, 60) },
    );
    expect(found).toEqual([]);
  });

  it("does not fire on back-to-back placement in the same room", () => {
    // fixed-a ends at 11:00; starting exactly at 11:00 is adjacency, not overlap.
    const mover = entry("mover", null, 60, { participants: [RILEY] });
    const found = predictConflicts(programme(mover), {
      sessionId: "mover",
      roomId: ROOM_A,
      ...slot(11, 60),
    });
    expect(found).toEqual([]);
  });

  it("does not fire for a same-time placement in another room with another person", () => {
    const mover = entry("mover", null, 60, { participants: [RILEY] });
    const found = predictConflicts(programme(mover), {
      sessionId: "mover",
      roomId: ROOM_B,
      ...slot(10, 60), // same clock time as fixed-a, different room and person
    });
    expect(found).toEqual([]);
  });

  it("ignores collisions the moved session is not part of", () => {
    // Two OTHER sessions already clash with each other; the mover lands clean.
    const clashA = entry("clash-a", 12, 60, { roomId: ROOM_A, participants: [SAM] });
    const clashB = entry("clash-b", 12, 60, { roomId: ROOM_A, participants: [SAM] });
    const mover = entry("mover", null, 60, { participants: [RILEY] });

    const found = predictConflicts([clashA, clashB, mover], {
      sessionId: "mover",
      roomId: ROOM_B,
      ...slot(18, 60),
    });

    // The programme is not conflict-free, but THIS move creates nothing.
    expect(findConflicts([clashA, clashB]).length).toBeGreaterThan(0);
    expect(found).toEqual([]);
  });
});

describe("predictConflicts — names the room being moved INTO", () => {
  it("reports the target room's name, not the one the session is leaving", () => {
    /*
     * `mover` currently sits in Workshop Room and is dragged onto Main Stage,
     * where fixed-a already is. `findRoomConflicts` labels the bucket from the
     * first entry in it, so carrying the id without the name can report the
     * clash against "Workshop Room" — the room the organiser just moved away
     * from, which is the one room the message must not name.
     */
    const mover = entry("mover", 8, 60, {
      roomId: ROOM_B,
      roomName: "Workshop Room",
      participants: [RILEY],
    });
    const found = predictConflicts(programme(mover), {
      sessionId: "mover",
      roomId: ROOM_A,
      roomName: "Main Stage",
      ...slot(10, 60),
    });

    expect(found).toHaveLength(1);
    expect(found[0].resourceId).toBe(ROOM_A);
    expect(found[0].resourceName).toBe("Main Stage");
  });
});

describe("prediction agrees with the detector that runs after the write", () => {
  it("equals findConflicts on the programme the move would produce", () => {
    /*
     * Prediction must never be a second implementation of the overlap rule. Apply
     * the proposed placement for real, run the post-hoc detector the Conflicts
     * screen uses, and the two must name the same conflicts.
     */
    const mover = entry("mover", 18, 60, { roomId: ROOM_B, participants: [SAM] });
    const before = programme(mover);
    const proposed = { sessionId: "mover", roomId: ROOM_A, ...slot(10, 45) };

    const predicted = predictConflicts(before, proposed);

    const after = before.map((row) =>
      row.id === "mover"
        ? { ...row, roomId: proposed.roomId, startsAt: proposed.startsAt, endsAt: proposed.endsAt }
        : row,
    );
    const actual = findConflicts(after).filter(
      (c) => c.a.id === "mover" || c.b.id === "mover",
    );

    expect(predicted).toEqual(actual);
    expect(predicted.length).toBeGreaterThan(0); // the case would be vacuous otherwise
  });
});
