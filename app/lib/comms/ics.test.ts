/**
 * ICS lifecycle tests — PLAN.md §7 lists these as BINDING for WS5:
 * "stable UID, SEQUENCE bump on update, METHOD:CANCEL on unschedule".
 *
 * Every assertion runs against PARSED, UNFOLDED properties (`parseIcs`), not
 * against substrings of the blob. `toContain("SEQUENCE:1")` is green on a
 * document whose folding is broken and which no calendar client can read — the
 * check has to fail for the reason a real client would.
 */
import { describe, expect, it } from "vitest";

import {
  buildIcs,
  escapeIcsText,
  foldIcsLine,
  formatIcsDate,
  icsContentType,
  icsUid,
  icsValue,
  icsValues,
  nextSequence,
  parseIcs,
  type IcsEventInput,
} from "./ics";
import { parseSender } from "./sender";

const START = new Date("2026-10-07T17:00:00Z");
const END = new Date("2026-10-07T17:30:00Z");
const STAMP = new Date("2026-08-08T10:10:44Z");

const SESSION_ID = "5e000000-0000-4000-8000-000000000001";
const HOST = "callboard.example.workers.dev";

function input(over: Partial<IcsEventInput> = {}): IcsEventInput {
  return {
    uid: icsUid(SESSION_ID, HOST),
    sequence: 0,
    method: "REQUEST",
    dtstamp: STAMP,
    start: START,
    end: END,
    summary: "Shipping agents that survive contact with users",
    description: "Main Stage. Your speaker portal has the run of show.",
    location: "Main Stage, Frontier AI Summit",
    organizer: { name: "Callboard", email: "onboarding@resend.dev" },
    attendees: [{ email: "speaker@callboard.dev", name: "Sam Speaker" }],
    ...over,
  };
}

const props = (over: Partial<IcsEventInput> = {}) => parseIcs(buildIcs(input(over)));

/* ------------------------------------------------------------------ UID */

describe("UID stability", () => {
  it("MUST-FIRE: the same session id + host always produces the same UID", () => {
    expect(icsUid(SESSION_ID, HOST)).toBe(icsUid(SESSION_ID, HOST));
    expect(icsUid(SESSION_ID, HOST)).toBe(`callboard-${SESSION_ID}@${HOST}`);
  });

  it("MUST-FIRE: UID survives regeneration across the whole lifecycle", () => {
    const invite = icsValue(props({ sequence: 0, method: "REQUEST" }), "UID");
    const update = icsValue(props({ sequence: 1, method: "REQUEST" }), "UID");
    const cancel = icsValue(props({ sequence: 2, method: "CANCEL" }), "UID");

    expect(invite).toBe(`callboard-${SESSION_ID}@${HOST}`);
    expect(new Set([invite, update, cancel]).size).toBe(1);
  });

  it("MUST-FIRE: a rescheduled session keeps its UID while its times change", () => {
    const first = props({ start: START, end: END });
    const moved = props({
      sequence: 1,
      start: new Date("2026-10-08T21:00:00Z"),
      end: new Date("2026-10-08T22:00:00Z"),
    });

    expect(icsValue(moved, "UID")).toBe(icsValue(first, "UID"));
    expect(icsValue(moved, "DTSTART")).not.toBe(icsValue(first, "DTSTART"));
    expect(icsValue(moved, "DTSTART")).toBe("20261008T210000Z");
  });

  it("MUST-NOT-FIRE: a different session is a different UID (never a silent merge)", () => {
    expect(icsUid("other-session", HOST)).not.toBe(icsUid(SESSION_ID, HOST));
  });

  it("MUST-NOT-FIRE: the same session on another deployment does not collide", () => {
    expect(icsUid(SESSION_ID, "preview.callboard.workers.dev")).not.toBe(
      icsUid(SESSION_ID, HOST),
    );
  });

  it("accepts a full origin as the host and keeps only the hostname", () => {
    expect(icsUid(SESSION_ID, "https://callboard.test:8787/admin")).toBe(
      `callboard-${SESSION_ID}@callboard.test`,
    );
  });
});

/* ------------------------------------------------------------- SEQUENCE */

describe("SEQUENCE", () => {
  it("MUST-FIRE: the first send is 0 and each later send is exactly one higher", () => {
    expect(nextSequence([])).toBe(0);
    expect(nextSequence([0])).toBe(1);
    expect(nextSequence([0, 1])).toBe(2);
    expect(nextSequence([0, 1, 2])).toBe(3);
  });

  it("MUST-FIRE: SEQUENCE bumps in the emitted document on an update", () => {
    const invite = props({ sequence: nextSequence([]) });
    const update = props({ sequence: nextSequence([0]) });

    expect(icsValue(invite, "SEQUENCE")).toBe("0");
    expect(icsValue(update, "SEQUENCE")).toBe("1");
    expect(Number(icsValue(update, "SEQUENCE"))).toBeGreaterThan(
      Number(icsValue(invite, "SEQUENCE")),
    );
  });

  it("MUST-NOT-FIRE: a gap in the log never reissues a number already used", () => {
    // A failed send still writes a comm_log row, so sequences are not dense.
    expect(nextSequence([0, 2])).toBe(3);
    expect(nextSequence([5])).toBe(6);
  });

  it("ignores nulls and non-numbers from the log rather than resetting to 0", () => {
    expect(nextSequence([null, undefined, 3, Number.NaN])).toBe(4);
    expect(nextSequence([null, undefined])).toBe(0);
  });

  it("never emits a negative SEQUENCE", () => {
    expect(icsValue(props({ sequence: -4 }), "SEQUENCE")).toBe("0");
  });
});

/* ---------------------------------------------------------------- CANCEL */

describe("METHOD:CANCEL", () => {
  it("MUST-FIRE: a cancel carries METHOD:CANCEL and STATUS:CANCELLED", () => {
    const cancel = props({ method: "CANCEL", sequence: 1 });

    expect(icsValue(cancel, "METHOD")).toBe("CANCEL");
    expect(icsValue(cancel, "STATUS")).toBe("CANCELLED");
    expect(icsValue(cancel, "SEQUENCE")).toBe("1");
    expect(icsValue(cancel, "UID")).toBe(`callboard-${SESSION_ID}@${HOST}`);
  });

  it("MUST-FIRE: the cancel MIME type carries method=CANCEL", () => {
    expect(icsContentType("CANCEL")).toBe('text/calendar; charset="utf-8"; method=CANCEL');
  });

  it("MUST-NOT-FIRE: an invite is never CANCELLED", () => {
    const invite = props();
    expect(icsValue(invite, "METHOD")).toBe("REQUEST");
    expect(icsValue(invite, "STATUS")).toBe("CONFIRMED");
    expect(icsValue(invite, "STATUS")).not.toBe("CANCELLED");
  });

  it("MUST-FIRE: the invite MIME type is the exact string the Gmail spike proved", () => {
    // DECISIONS.md #28 — this literal is what flips Gmail into invite rendering.
    expect(icsContentType("REQUEST")).toBe('text/calendar; charset="utf-8"; method=REQUEST');
  });
});

/* ----------------------------------------------------- ORGANIZER lockstep */

describe("ORGANIZER", () => {
  it("MUST-FIRE: ORGANIZER mailto equals the From address, for every sender form", () => {
    // The spike's load-bearing finding: a mismatch kills the invite card.
    for (const raw of [
      "Callboard <onboarding@resend.dev>",
      "speakers@chainofthought.show",
      "AI Engineer Program <program@ai.engineer>",
      "",
      "not an address at all",
    ]) {
      const sender = parseSender(raw);
      const organizer = icsValue(props({ organizer: sender }), "ORGANIZER");
      expect(organizer).toBe(`mailto:${sender.email}`);
      expect(sender.display).toContain(sender.email);
    }
  });

  it("lists every attendee as a NEEDS-ACTION participant", () => {
    const parsed = props({
      attendees: [
        { email: "speaker@callboard.dev", name: "Sam Speaker" },
        { email: "rina@example.com", name: "Rina Okafor" },
      ],
    });

    expect(icsValues(parsed, "ATTENDEE")).toEqual([
      "mailto:speaker@callboard.dev",
      "mailto:rina@example.com",
    ]);
    const attendee = parseIcs(
      buildIcs(input({ attendees: [{ email: "rina@example.com", name: "Rina Okafor" }] })),
    ).find((property) => property.name === "ATTENDEE");
    expect(attendee?.params.PARTSTAT).toBe("NEEDS-ACTION");
    expect(attendee?.params.RSVP).toBe("TRUE");
    expect(attendee?.params.CN).toBe("Rina Okafor");
  });

  it("falls back to the address when an attendee has no name", () => {
    const attendee = props({ attendees: [{ email: "nameless@example.com" }] }).find(
      (property) => property.name === "ATTENDEE",
    );
    expect(attendee?.params.CN).toBe("nameless@example.com");
  });
});

/* ------------------------------------------------------------- structure */

describe("document structure", () => {
  it("is a well-formed VCALENDAR with one VEVENT and CRLF line endings", () => {
    const ics = buildIcs(input());

    expect(ics.startsWith("BEGIN:VCALENDAR\r\n")).toBe(true);
    expect(ics.endsWith("END:VCALENDAR\r\n")).toBe(true);
    expect(ics.split("\r\n").length - 1).toBe(ics.split("\n").length - 1);

    const names = parseIcs(ics).map((property) => property.name);
    expect(names.filter((name) => name === "BEGIN")).toHaveLength(2);
    expect(names.filter((name) => name === "END")).toHaveLength(2);
    expect(names.indexOf("BEGIN")).toBeLessThan(names.indexOf("END"));
  });

  it("stamps DTSTAMP/DTSTART/DTEND in RFC 5545 UTC form", () => {
    const parsed = props();
    expect(icsValue(parsed, "DTSTAMP")).toBe("20260808T101044Z");
    expect(icsValue(parsed, "DTSTART")).toBe("20261007T170000Z");
    expect(icsValue(parsed, "DTEND")).toBe("20261007T173000Z");
    for (const key of ["DTSTAMP", "DTSTART", "DTEND"]) {
      expect(icsValue(parsed, key)).toMatch(/^\d{8}T\d{6}Z$/);
    }
  });

  it("MUST-FIRE: a DTSTAMP is always present — a REQUEST without one is invalid", () => {
    expect(icsValue(props(), "DTSTAMP")).not.toBeNull();
    expect(formatIcsDate(new Date("2026-01-02T03:04:05.678Z"))).toBe("20260102T030405Z");
  });

  it("escapes TEXT values so a comma cannot forge a property list", () => {
    const parsed = props({
      summary: "Evals, guardrails; and other lies",
      location: "Room 2, Level 3",
      description: "Line one\nLine two",
    });

    expect(icsValue(parsed, "SUMMARY")).toBe("Evals\\, guardrails\\; and other lies");
    expect(icsValue(parsed, "LOCATION")).toBe("Room 2\\, Level 3");
    expect(icsValue(parsed, "DESCRIPTION")).toBe("Line one\\nLine two");
    expect(escapeIcsText("a\\b")).toBe("a\\\\b");
  });

  it("folds every content line to 75 octets and survives unfolding intact", () => {
    const long =
      "A session title that is deliberately far longer than seventy-five octets " +
      "so the folding logic has to do real work, with an emoji 🚀 near the fold";
    const ics = buildIcs(input({ summary: long }));
    const encoder = new TextEncoder();

    for (const line of ics.split("\r\n")) {
      expect(encoder.encode(line).length).toBeLessThanOrEqual(75);
    }
    // Unfolding must give the escaped original back — folding is transport-only.
    expect(icsValue(parseIcs(ics), "SUMMARY")).toBe(escapeIcsText(long));
  });

  it("MUST-NOT-FIRE: a short line is never folded", () => {
    expect(foldIcsLine("SUMMARY:short")).toEqual(["SUMMARY:short"]);
    expect(foldIcsLine("X".repeat(75))).toHaveLength(1);
    expect(foldIcsLine("X".repeat(76))).toHaveLength(2);
  });

  it("omits optional properties rather than emitting empty ones", () => {
    const parsed = props({ description: null, location: null, url: null });
    expect(icsValue(parsed, "DESCRIPTION")).toBeNull();
    expect(icsValue(parsed, "LOCATION")).toBeNull();
    expect(icsValue(parsed, "URL")).toBeNull();
    // …while the required ones are still there.
    expect(icsValue(parsed, "SUMMARY")).not.toBeNull();
  });
});
