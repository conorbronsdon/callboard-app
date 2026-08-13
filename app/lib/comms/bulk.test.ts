/** Pure bulk audience, fallback, and validation red proofs. */
import { describe, expect, it } from "vitest";

import { renderEmail } from "./templates";
import {
  MAX_BULK_RECIPIENTS,
  buildRecipientContext,
  hashBulkSendContent,
  hashRecipientIds,
  selectRecipients,
  validateCompose,
  type BulkRecipient,
} from "./bulk";

describe("hashRecipientIds", () => {
  it("MUST-NOT-FIRE: input order does not change the fingerprint", () => {
    expect(hashRecipientIds(["speaker-b", "speaker-a", "speaker-c"])).toBe(
      hashRecipientIds(["speaker-c", "speaker-b", "speaker-a"]),
    );
  });

  it("MUST-FIRE: a changed recipient set changes the fingerprint", () => {
    expect(hashRecipientIds(["speaker-a", "speaker-b"])).not.toBe(
      hashRecipientIds(["speaker-a", "speaker-c"]),
    );
  });

  it("keeps the empty-set fingerprint stable", () => {
    expect(hashRecipientIds([])).toBe(hashRecipientIds([]));
  });

  it("MUST-NOT-FIRE complement: concrete different same-length sets do not collide", () => {
    expect(hashRecipientIds(["alpha", "bravo"])).not.toBe(
      hashRecipientIds(["charlie", "delta"]),
    );
  });
});

describe("hashBulkSendContent", () => {
  const base = {
    eventId: "evt-1",
    recipients: ["speaker-a", "speaker-b"],
    subject: "Schedule change",
    body: "Your session has moved rooms.",
    audience: "all_speakers",
  };

  it("MUST-NOT-FIRE: recipient order does not change the fingerprint", () => {
    expect(hashBulkSendContent(base)).toBe(
      hashBulkSendContent({ ...base, recipients: [...base.recipients].reverse() }),
    );
  });

  it("MUST-FIRE: a different subject changes the fingerprint", () => {
    expect(hashBulkSendContent(base)).not.toBe(
      hashBulkSendContent({ ...base, subject: "Different subject" }),
    );
  });

  it("MUST-FIRE: a different body changes the fingerprint", () => {
    expect(hashBulkSendContent(base)).not.toBe(
      hashBulkSendContent({ ...base, body: "Different body." }),
    );
  });

  it("MUST-FIRE: a different event or audience changes the fingerprint", () => {
    expect(hashBulkSendContent(base)).not.toBe(
      hashBulkSendContent({ ...base, eventId: "evt-2" }),
    );
    expect(hashBulkSendContent(base)).not.toBe(
      hashBulkSendContent({ ...base, audience: "accepted" }),
    );
  });

  it("MUST-FIRE: a different recipient set changes the fingerprint", () => {
    expect(hashBulkSendContent(base)).not.toBe(
      hashBulkSendContent({ ...base, recipients: ["speaker-a", "speaker-c"] }),
    );
  });

  it("MUST-NOT-FIRE complement: two identical calls fingerprint the same", () => {
    expect(hashBulkSendContent(base)).toBe(hashBulkSendContent({ ...base }));
  });
});

const base = (overrides: Partial<BulkRecipient> = {}): BulkRecipient => ({
  personId: "p1",
  email: "ingrid@example.com",
  fullName: "Ingrid Falconer",
  firstName: "Ingrid",
  eventRole: "speaker",
  sessions: [],
  openTasks: [],
  ...overrides,
});

const session = (status: string, trackId = "track-1") => ({
  id: `${status}-${trackId}`,
  friendlyId: "ABS-1",
  title: `${status} session`,
  status,
  trackId,
  startsAt: Date.UTC(2027, 4, 1, 17),
  endsAt: Date.UTC(2027, 4, 1, 18),
  roomName: "Main Hall",
  formName: "DevFlow CFP",
  updatedAt: Date.UTC(2027, 0, 1),
});

describe("selectRecipients", () => {
  const candidates = [
    base({ personId: "accepted", sessions: [session("accepted")] }),
    base({ personId: "pending", sessions: [session("pending"), session("draft")] }),
    base({ personId: "mixed", sessions: [session("accepted"), session("pending")] }),
    base({ personId: "declined", sessions: [session("declined", "track-2")] }),
    base({ personId: "tasked", openTasks: [{ id: "t1", title: "Slides", dueAt: null, status: "in_progress" }] }),
    base({ personId: "complete", openTasks: [{ id: "t2", title: "Bio", dueAt: null, status: "complete" }] }),
    base({ personId: "organizer", eventRole: "organizer" }),
  ];

  it("MUST-FIRE: each audience includes exactly its matching speakers", () => {
    expect(selectRecipients(candidates, "all_speakers").map((row) => row.personId)).toHaveLength(6);
    expect(selectRecipients(candidates, "accepted").map((row) => row.personId)).toEqual(["accepted", "mixed"]);
    expect(selectRecipients(candidates, "pending").map((row) => row.personId)).toEqual(["pending"]);
    expect(selectRecipients(candidates, "outstanding_tasks").map((row) => row.personId)).toEqual(["tasked"]);
    expect(selectRecipients(candidates, "track", "track-2").map((row) => row.personId)).toEqual(["declined"]);
  });

  it("MUST-NOT-FIRE: carve-outs do not over-include organizers, mixed decisions, completed tasks, or blank tracks", () => {
    expect(selectRecipients(candidates, "all_speakers").some((row) => row.personId === "organizer")).toBe(false);
    expect(selectRecipients(candidates, "pending").some((row) => row.personId === "mixed")).toBe(false);
    expect(selectRecipients(candidates, "pending").some((row) => row.personId === "tasked")).toBe(false);
    expect(selectRecipients(candidates, "outstanding_tasks").some((row) => row.personId === "complete")).toBe(false);
    expect(selectRecipients(candidates, "track", "")).toEqual([]);
  });
});

describe("buildRecipientContext", () => {
  it("MUST-FIRE: resolves real speaker, accepted session, task, due date, and portal values", () => {
    const recipient = base({
      sessions: [session("pending", "track-2"), session("accepted")],
      openTasks: [
        { id: "task-1", title: "Upload your slides", dueAt: Date.UTC(2027, 3, 20), status: "pending" },
      ],
    });
    const built = buildRecipientContext(
      recipient,
      { name: "DevFlow Conf 2027", location: "Paris", timezone: "UTC" },
      { origin: "https://callboard.test/", now: Date.UTC(2027, 3, 1) },
    );
    const rendered = renderEmail(
      {
        key: "task_reminder",
        subject: "Hi {{speaker.first_name}} — {{task.count}} task",
        body: "{{session.title}}\n{{task.list}}\nDue {{task.due}}\n{{portal.url}}",
      },
      built.context,
    );

    expect(rendered.subject).toBe("Hi Ingrid — 1 task");
    expect(rendered.text).toContain("accepted session");
    expect(rendered.text).toContain("Upload your slides");
    expect(rendered.text).toContain("Tue, Apr 20, 2027");
    expect(rendered.text).toContain("https://callboard.test/portal");
    expect(built.taskIds).toEqual(["task-1"]);
  });

  it("MUST-FIRE: honestly fills missing session, first-name, and task fields", () => {
    const built = buildRecipientContext(
      base({ email: "mystery@example.com", fullName: null, firstName: null }),
      { name: "DevFlow Conf 2027", location: null, timezone: "UTC" },
      { origin: "https://callboard.test", now: 0 },
    );
    const rendered = renderEmail(
      {
        key: "bulk_custom" as never,
        subject: "Hi {{speaker.first_name}}",
        body: "{{session.title}} at {{session.time}} in {{session.room}}. {{task.list}}; due {{task.due}}.",
      },
      built.context,
    );

    expect(rendered.subject).toBe("Hi mystery");
    expect(rendered.text).toContain("your session at a time we will confirm in a room we will confirm");
    expect(rendered.text).toContain("no open tasks; due no due date");
    expect(built.fallbacksUsed).toEqual(expect.arrayContaining([
      "session.title",
      "session.time",
      "session.room",
      "task.list",
      "task.count",
      "task.due",
    ]));
    expect(`${rendered.subject}\n${rendered.text}`).not.toContain("undefined");
    expect(`${rendered.subject}\n${rendered.text}`).not.toContain("{{");
  });
});

describe("validateCompose", () => {
  const valid = {
    subject: "Welcome",
    body: "Hi there",
    recipientIds: ["p1"],
    audience: "all_speakers",
  } as const;

  it.each([
    [{ ...valid, subject: " " }, "A subject is required"],
    [{ ...valid, body: " " }, "A body is required"],
    [{ ...valid, recipientIds: [] }, "Select at least one recipient"],
    [{ ...valid, audience: "track", trackId: "" }, "Choose a track"],
    [{ ...valid, audience: "track", trackId: "other", validTrackIds: ["known"] }, "belongs to this event"],
    [{ ...valid, audience: "unknown" }, "known recipient audience"],
    [{ ...valid, recipientIds: Array.from({ length: MAX_BULK_RECIPIENTS + 1 }, (_, i) => `p${i}`) }, "no more than"],
  ])("MUST-FIRE: rejects invalid compose input %#", (input, message) => {
    const result = validateCompose(input);
    expect(result.ok).toBe(false);
    expect(result.error).toContain(message);
  });

  it.each([
    valid,
    { ...valid, recipientIds: Array.from({ length: MAX_BULK_RECIPIENTS }, (_, i) => `p${i}`) },
    { ...valid, audience: "track", trackId: "known", validTrackIds: ["known"] },
  ])("MUST-NOT-FIRE: accepts the valid complement %#", (input) => {
    expect(validateCompose(input)).toEqual({ ok: true, error: null });
  });
});
