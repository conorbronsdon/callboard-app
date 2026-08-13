/**
 * The pure invite builder: which changes produce email, and what the ICS says.
 * The DB-backed lifecycle (invite -> update -> cancel with a rising SEQUENCE)
 * is in schedule-invite.server.test.ts.
 */
import { describe, expect, it } from "vitest";

import { icsUid, icsValue, parseIcs } from "./ics";
import { buildScheduleInvite, firstNameOf, type ScheduleInviteInput } from "./schedule-invite";
import { parseSender } from "./sender";
import { DEFAULT_TEMPLATES } from "./templates";

const SESSION_ID = "5e000000-0000-4000-8000-000000000001";
const HOST = "callboard.test";

function input(over: Partial<ScheduleInviteInput> = {}): ScheduleInviteInput {
  return {
    action: "invite",
    uid: icsUid(SESSION_ID, HOST),
    sequence: 0,
    dtstamp: new Date("2026-08-08T10:10:44Z"),
    startsAt: new Date("2026-10-07T17:00:00Z"),
    endsAt: new Date("2026-10-07T17:30:00Z"),
    sessionTitle: "Shipping agents that survive contact with users",
    sessionDescription: "What breaks when real users arrive.",
    roomName: "Main Stage",
    eventName: "Frontier AI Summit 2026",
    eventLocation: "San Francisco, CA",
    timeLabel: "Wed Oct 7, 2026 · 10:00 AM – 10:30 AM",
    portalUrl: "https://callboard.test/portal",
    scheduleUrl: "https://callboard.test/e/aie/schedule",
    sender: parseSender("Callboard <onboarding@resend.dev>"),
    attendees: [
      { personId: "p1", email: "speaker@callboard.dev", name: "Sam Speaker" },
    ],
    template: DEFAULT_TEMPLATES.schedule_invite,
    isPublished: true,
    ...over,
  };
}

describe("guards", () => {
  it("MUST-NOT-FIRE: an unpublished session produces no email at all", () => {
    expect(buildScheduleInvite(input({ isPublished: false }))).toBeNull();
  });

  it("MUST-NOT-FIRE: a session with no participants produces no email", () => {
    expect(buildScheduleInvite(input({ attendees: [] }))).toBeNull();
  });

  it("MUST-NOT-FIRE: no start or no end means no calendar entry to send", () => {
    expect(buildScheduleInvite(input({ startsAt: null }))).toBeNull();
    expect(buildScheduleInvite(input({ endsAt: null }))).toBeNull();
    // …including a cancel: a CANCEL has to name the slot it withdraws.
    expect(
      buildScheduleInvite(
        input({
          action: "cancel",
          template: DEFAULT_TEMPLATES.schedule_cancel,
          startsAt: null,
        }),
      ),
    ).toBeNull();
  });

  it("MUST-FIRE: a published, timed session with participants does produce email", () => {
    const built = buildScheduleInvite(input());
    expect(built).not.toBeNull();
    expect(built!.messages).toHaveLength(1);
  });
});

describe("invite", () => {
  const built = buildScheduleInvite(input())!;
  const message = built.messages[0];
  const ics = parseIcs(message.attachments![0].content);

  it("addresses the speaker and carries the invite attachment", () => {
    expect(message.to).toBe("speaker@callboard.dev");
    expect(message.attachments).toHaveLength(1);
    expect(message.attachments![0].filename).toBe("invite.ics");
    expect(message.attachments![0].contentType).toBe(
      'text/calendar; charset="utf-8"; method=REQUEST',
    );
  });

  it("renders the template's merge fields into subject and body", () => {
    expect(message.subject).toBe(
      "Your slot at Frontier AI Summit 2026: Shipping agents that survive contact with users",
    );
    expect(message.text).toContain("Hi Sam,");
    expect(message.text).toContain("Wed Oct 7, 2026 · 10:00 AM – 10:30 AM");
    expect(message.text).toContain("Main Stage");
    expect(message.text).toContain("https://callboard.test/portal");
    expect(message.text).not.toMatch(/\{\{/);
  });

  it("MUST-FIRE: From and ORGANIZER name the same address", () => {
    expect(message.from).toBe("Callboard <onboarding@resend.dev>");
    expect(icsValue(ics, "ORGANIZER")).toBe("mailto:onboarding@resend.dev");
  });

  it("puts room and city in LOCATION and the schedule link in URL", () => {
    expect(icsValue(ics, "LOCATION")).toBe("Main Stage\\, San Francisco\\, CA");
    expect(icsValue(ics, "URL")).toBe("https://callboard.test/e/aie/schedule");
    expect(icsValue(ics, "SUMMARY")).toBe(
      "Shipping agents that survive contact with users",
    );
  });

  it("MUST-NOT-FIRE: an unassigned room never renders as a blank line", () => {
    const built = buildScheduleInvite(input({ roomName: null }))!;
    expect(built.messages[0].text).toContain("Room to be confirmed");
    expect(built.messages[0].text).not.toMatch(/\n\n\n/);
    // …and LOCATION falls back to the city rather than a leading comma.
    expect(icsValue(parseIcs(built.messages[0].attachments![0].content), "LOCATION")).toBe(
      "San Francisco\\, CA",
    );
  });

  it("MUST-NOT-FIRE: one recipient's ICS never lists the other speakers", () => {
    const multi = buildScheduleInvite(
      input({
        attendees: [
          { personId: "p1", email: "speaker@callboard.dev", name: "Sam Speaker" },
          { personId: "p2", email: "rina@example.com", name: "Rina Okafor" },
        ],
      }),
    )!;

    expect(multi.messages).toHaveLength(2);
    for (const [index, msg] of multi.messages.entries()) {
      const attendees = parseIcs(msg.attachments![0].content).filter(
        (property) => property.name === "ATTENDEE",
      );
      expect(attendees).toHaveLength(1);
      expect(attendees[0].value).toBe(`mailto:${msg.to}`);
      expect(msg.text).toContain(index === 0 ? "Hi Sam," : "Hi Rina,");
    }
  });
});

describe("update", () => {
  it("uses the change template, keeps the UID and carries a higher SEQUENCE", () => {
    const invite = buildScheduleInvite(input())!;
    const update = buildScheduleInvite(
      input({
        action: "update",
        sequence: 1,
        template: DEFAULT_TEMPLATES.schedule_update,
        startsAt: new Date("2026-10-08T21:00:00Z"),
        endsAt: new Date("2026-10-08T22:00:00Z"),
        timeLabel: "Thu Oct 8, 2026 · 2:00 PM – 3:00 PM",
      }),
    )!;

    const before = parseIcs(invite.messages[0].attachments![0].content);
    const after = parseIcs(update.messages[0].attachments![0].content);

    expect(icsValue(after, "UID")).toBe(icsValue(before, "UID"));
    expect(icsValue(after, "SEQUENCE")).toBe("1");
    expect(icsValue(after, "METHOD")).toBe("REQUEST");
    expect(icsValue(after, "DTSTART")).toBe("20261008T210000Z");
    expect(update.messages[0].subject).toContain("Updated time");
    expect(update.messages[0].text).toContain("Thu Oct 8, 2026");
  });
});

describe("cancel", () => {
  const built = buildScheduleInvite(
    input({ action: "cancel", sequence: 2, template: DEFAULT_TEMPLATES.schedule_cancel }),
  )!;
  const message = built.messages[0];
  const ics = parseIcs(message.attachments![0].content);

  it("MUST-FIRE: METHOD:CANCEL, STATUS:CANCELLED, cancel.ics, method=CANCEL", () => {
    expect(icsValue(ics, "METHOD")).toBe("CANCEL");
    expect(icsValue(ics, "STATUS")).toBe("CANCELLED");
    expect(message.attachments![0].filename).toBe("cancel.ics");
    expect(message.attachments![0].contentType).toBe(
      'text/calendar; charset="utf-8"; method=CANCEL',
    );
  });

  it("keeps the UID so the client cancels the event it already holds", () => {
    expect(icsValue(ics, "UID")).toBe(icsUid(SESSION_ID, HOST));
    expect(icsValue(ics, "SEQUENCE")).toBe("2");
  });

  it("names the slot being released and does not read as a rejection", () => {
    expect(message.subject).toContain("Cancelled:");
    expect(message.text).toContain("Wed Oct 7, 2026");
    expect(message.text).toContain("not a decision about your talk");
  });
});

describe("firstNameOf", () => {
  it("takes the first token, and returns null when there is nothing to take", () => {
    expect(firstNameOf("Sam Speaker")).toBe("Sam");
    expect(firstNameOf("  Rina   Okafor ")).toBe("Rina");
    expect(firstNameOf("Cher")).toBe("Cher");
    expect(firstNameOf("")).toBeNull();
    expect(firstNameOf(null)).toBeNull();
  });

  it("MUST-FIRE: skips an honorific rather than greeting someone as 'Dr.'", () => {
    // The demo seed really does contain "Dr. Amara Okonkwo".
    expect(firstNameOf("Dr. Amara Okonkwo")).toBe("Amara");
    expect(firstNameOf("Prof Ada Lovelace")).toBe("Ada");
    expect(firstNameOf("Ms. Rina Okafor")).toBe("Rina");
    expect(firstNameOf("Sir Tim Berners-Lee")).toBe("Tim");
  });

  it("MUST-NOT-FIRE: an honorific-only name is kept, never blanked", () => {
    expect(firstNameOf("Dr")).toBe("Dr");
    expect(firstNameOf("Dr.")).toBe("Dr.");
  });

  it("falls back to the address when a speaker has no name on file", () => {
    const built = buildScheduleInvite(
      input({ attendees: [{ personId: "p9", email: "nameless@example.com", name: null }] }),
    )!;
    expect(built.messages[0].text).toContain("Hi nameless@example.com,");
  });
});
