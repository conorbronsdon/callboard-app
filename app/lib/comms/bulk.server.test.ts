/** Set-based recipient loading and comm-log-decorated bulk delivery proofs. */
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { commLog, events } from "~/db/schema";
import { MemoryMailer, type Mailer } from "~/lib/mail/mailer";
import { getMailer } from "~/lib/mail/mailer.server";
import { installTestDb, type TestDbContext } from "~/test/db";
import { seedDemoFixture, seedOtherEvent, type DemoFixture } from "~/test/fixtures";

import { loadComposeRecipients, previewBulkComm, sendBulkComm } from "./bulk.server";

let ctx: TestDbContext;
let fixture: DemoFixture;

beforeEach(async () => {
  ctx = installTestDb();
  fixture = await seedDemoFixture(ctx.db);
});
afterEach(() => {
  vi.restoreAllMocks();
  ctx.close();
});

async function eventContext() {
  const [event] = await ctx.db.select().from(events).where(eq(events.id, fixture.eventId));
  return { name: event.name, location: event.location, timezone: event.timezone };
}

describe("loadComposeRecipients / previewBulkComm", () => {
  it("loads roster facts in sets and keeps tasks and sessions event-scoped", async () => {
    const recipients = await loadComposeRecipients({ eventId: fixture.eventId, db: ctx.db });
    expect(recipients).toHaveLength(9);
    const sam = recipients.find((recipient) => recipient.email === "speaker@callboard.dev")!;
    expect(sam.eventRole).toBe("speaker");
    expect(sam.sessions.some((session) => session.status === "accepted")).toBe(true);
    expect(sam.openTasks).toHaveLength(2);
  });

  it("MUST-FIRE: preview resolves the chosen real speaker, task, and session", async () => {
    const recipients = await loadComposeRecipients({ eventId: fixture.eventId, db: ctx.db });
    const sam = recipients.find((recipient) => recipient.email === "speaker@callboard.dev")!;
    const preview = previewBulkComm({
      recipient: sam,
      event: await eventContext(),
      subject: "Welcome {{speaker.first_name}}",
      body: "Hi {{speaker.first_name}} — {{session.title}}. {{task.list}}",
      origin: "https://callboard.test",
    });
    expect(preview.subject).toBe("Welcome Sam");
    expect(preview.text).toContain("Hi Sam — Shipping agents that survive contact with users");
    expect(preview.text).toContain("Upload a headshot");
    expect(preview.unknownFields).toEqual([]);
  });

  it("reports unknown merge fields while rendering them safely", async () => {
    const [recipient] = await loadComposeRecipients({ eventId: fixture.eventId, db: ctx.db });
    const preview = previewBulkComm({
      recipient,
      event: await eventContext(),
      subject: "{{speaker.first_name}} {{typo.name}}",
      body: "Body",
      origin: "https://callboard.test",
    });
    expect(preview.unknownFields).toEqual(["typo.name"]);
    expect(preview.subject).not.toContain("{{");
  });
});

describe("sendBulkComm", () => {
  it("MUST-FIRE: three recipients create exactly three resolved sent comm-log rows", async () => {
    const mailer = new MemoryMailer();
    const ids = fixture.speakerIds.slice(0, 3);
    const result = await sendBulkComm({
      eventId: fixture.eventId,
      event: await eventContext(),
      recipients: ids,
      subject: "Welcome {{speaker.first_name}}",
      body: "Hi {{speaker.first_name}}, your session is {{session.title}}.",
      templateKey: null,
      templateId: null,
      audience: "all_speakers",
      origin: "https://callboard.test",
      mailer,
      db: ctx.db,
      now: new Date("2027-01-01T00:00:00Z"),
    });
    expect(result).toMatchObject({ attempted: 3, sent: 3, failed: 0 });
    expect(mailer.sent).toHaveLength(3);
    expect(mailer.sent[0].subject).toBe("Welcome Sam");
    expect(mailer.sent[0].text).toContain("Hi Sam");
    expect(JSON.stringify(mailer.sent)).not.toContain("{{speaker.first_name}}");

    const logged = await ctx.db.select().from(commLog).where(eq(commLog.eventId, fixture.eventId));
    expect(logged).toHaveLength(3);
    expect(logged.map((row) => row.toEmail).sort()).toEqual(mailer.sent.map((row) => row.to).sort());
    expect(logged.every((row) => row.status === "sent")).toBe(true);
    expect(logged.map((row) => row.personId).sort()).toEqual([...ids].sort());
    expect(logged.every((row) => row.meta?.bulk === true)).toBe(true);
    expect(logged.every((row) => row.meta?.templateKey === "bulk_custom")).toBe(true);
    expect(logged[0].subject).not.toContain("{{");
  });

  it("MUST-FIRE: task-reminder bulk meta stamps exactly the open task ids", async () => {
    const result = await sendBulkComm({
      eventId: fixture.eventId,
      event: await eventContext(),
      recipients: [fixture.speakerIds[0]],
      subject: "{{task.count}} tasks",
      body: "{{task.list}} due {{task.due}}",
      templateKey: "task_reminder",
      audience: "outstanding_tasks",
      origin: "https://callboard.test",
      mailer: new MemoryMailer(),
      db: ctx.db,
    });
    expect(result.sent).toBe(1);
    const [logged] = await ctx.db.select().from(commLog);
    expect(logged.meta?.templateKey).toBe("task_reminder");
    expect(logged.meta?.taskIds).toHaveLength(2);
  });

  it("MUST-NOT-FIRE: an empty recipient set rejects before sending or logging", async () => {
    const mailer = new MemoryMailer();
    const result = await sendBulkComm({
      eventId: fixture.eventId,
      event: await eventContext(),
      recipients: [],
      subject: "Subject",
      body: "Body",
      audience: "all_speakers",
      origin: "https://callboard.test",
      mailer,
      db: ctx.db,
    });
    expect(result).toMatchObject({ attempted: 0, sent: 0, failed: 0 });
    expect(result.error).toContain("Select at least one recipient");
    expect(mailer.sent).toHaveLength(0);
    expect(await ctx.db.select().from(commLog)).toHaveLength(0);
  });

  it("MUST-NOT-FIRE: one id from another event rejects the whole otherwise-valid send", async () => {
    const other = await seedOtherEvent(ctx.db);
    const mailer = new MemoryMailer();
    const result = await sendBulkComm({
      eventId: fixture.eventId,
      event: await eventContext(),
      recipients: [fixture.speakerIds[0], other.speakerId],
      subject: "Subject",
      body: "Body",
      audience: "all_speakers",
      origin: "https://callboard.test",
      mailer,
      db: ctx.db,
    });
    expect(result.error).toContain("1 selected recipient does not belong to this event");
    expect(result.sent).toBe(0);
    expect(mailer.sent).toHaveLength(0);
    expect(await ctx.db.select().from(commLog)).toHaveLength(0);
  });

  it("MUST-NOT-FIRE complement: the same two-recipient shape sends when both ids belong", async () => {
    const result = await sendBulkComm({
      eventId: fixture.eventId,
      event: await eventContext(),
      recipients: fixture.speakerIds.slice(0, 2),
      subject: "Subject",
      body: "Body",
      audience: "all_speakers",
      origin: "https://callboard.test",
      mailer: new MemoryMailer(),
      db: ctx.db,
    });
    expect(result).toMatchObject({ attempted: 2, sent: 2, failed: 0 });
    expect(await ctx.db.select().from(commLog)).toHaveLength(2);
  });

  it("continues after one returned or thrown failure and logs both failures", async () => {
    let calls = 0;
    const mailer: Mailer = {
      name: "fallible",
      observesDelivery: true,
      async send() {
        calls += 1;
        if (calls === 1) return { ok: false, error: "bad address" };
        if (calls === 2) throw new Error("provider timeout");
        return { ok: true, id: "ok-3" };
      },
    };
    const result = await sendBulkComm({
      eventId: fixture.eventId,
      event: await eventContext(),
      recipients: fixture.speakerIds.slice(0, 3),
      subject: "Subject",
      body: "Body",
      audience: "all_speakers",
      origin: "https://callboard.test",
      mailer,
      db: ctx.db,
    });
    expect(result).toMatchObject({ attempted: 3, sent: 1, failed: 2 });
    expect(await ctx.db.select().from(commLog)).toHaveLength(3);
    const statuses = (await ctx.db.select().from(commLog)).map((row) => row.status).sort();
    expect(statuses).toEqual(["failed", "failed", "sent"]);
  });

  it("MUST-NOT-FIRE: MAIL_DRIVER=console makes a valid bulk send with zero provider fetches", async () => {
    ctx.close();
    ctx = installTestDb({ RESEND_API_KEY: "re_live_shaped_key", MAIL_DRIVER: "console" });
    fixture = await seedDemoFixture(ctx.db);
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const mailer = getMailer();
    expect(mailer.name).toBe("console");
    const result = await sendBulkComm({
      eventId: fixture.eventId,
      event: await eventContext(),
      recipients: [fixture.speakerIds[0]],
      subject: "Subject",
      body: "Body",
      audience: "all_speakers",
      origin: "https://callboard.test",
      mailer,
      db: ctx.db,
    });
    expect(result.sent).toBe(1);
    expect(fetchSpy).toHaveBeenCalledTimes(0);
    expect(await ctx.db.select().from(commLog)).toHaveLength(1);
  });

  /*
   * Was QUARANTINED as a real, unfixed bug (blindspot audit, issue #198):
   * `sendBulkComm` had no idempotency key, no dedup window, and no lock, so
   * two concurrent calls with the same recipients/subject/body each ran to
   * full completion independently — the UI's "Send emails" button has no
   * `disabled`/submitting-state guard, so a double click or a rapid
   * double-Enter fired two overlapping POSTs, mailing every recipient
   * TWICE. Fixed by an idempotency claim: `sendBulkComm` inserts a row into
   * `comm_batches` keyed on (event_id, idempotency_key) before it sends
   * anything, and a second racing call with the same key loses the UNIQUE
   * index race and is refused. The route supplies its own per-render submit
   * nonce as that key; this test supplies none, so `hashBulkSendContent`
   * derives one from the call's own content — which is what makes a bare
   * `Promise.all([sendBulkComm(args), sendBulkComm(args)])` dedupe with no
   * caller changes.
   */
  it("MUST-FIRE: two concurrent identical sends do not both dispatch mail (issue #198)", async () => {
    const mailer = new MemoryMailer();
    const args = {
      eventId: fixture.eventId,
      event: await eventContext(),
      recipients: fixture.speakerIds.slice(0, 3),
      subject: "Schedule change",
      body: "Your session has moved rooms.",
      audience: "all_speakers" as const,
      origin: "https://callboard.test",
      mailer,
      db: ctx.db,
    };

    // Simulates the double-click: two requests racing through the same
    // action, both reaching sendBulkComm before either has finished.
    const [first, second] = await Promise.all([sendBulkComm(args), sendBulkComm(args)]);

    expect(first.sent + second.sent, "total successful sends across both concurrent calls").toBe(3);
    expect(mailer.sent, "each of the 3 recipients should receive exactly one copy").toHaveLength(3);
    const emailCounts = new Map<string, number>();
    for (const sent of mailer.sent) emailCounts.set(sent.to, (emailCounts.get(sent.to) ?? 0) + 1);
    expect([...emailCounts.values()], "no recipient should appear more than once").toEqual([1, 1, 1]);
  });

  it("MUST-NOT-FIRE: two DIFFERENT concurrent sends are unaffected by each other", async () => {
    const mailer = new MemoryMailer();
    const shared = {
      eventId: fixture.eventId,
      event: await eventContext(),
      audience: "all_speakers" as const,
      origin: "https://callboard.test",
      mailer,
      db: ctx.db,
    };
    const [first, second] = await Promise.all([
      sendBulkComm({
        ...shared,
        recipients: [fixture.speakerIds[0]],
        subject: "Reminder A",
        body: "Body A",
      }),
      sendBulkComm({
        ...shared,
        recipients: [fixture.speakerIds[1]],
        subject: "Reminder B",
        body: "Body B",
      }),
    ]);
    expect(first.sent).toBe(1);
    expect(second.sent).toBe(1);
    expect(mailer.sent).toHaveLength(2);
  });

  it("MUST-NOT-FIRE: identical content sent again after the dedup window is not blocked", async () => {
    const mailer = new MemoryMailer();
    const args = {
      eventId: fixture.eventId,
      event: await eventContext(),
      recipients: [fixture.speakerIds[0]],
      subject: "Weekly reminder",
      body: "Same body every week on purpose.",
      audience: "all_speakers" as const,
      origin: "https://callboard.test",
      mailer,
      db: ctx.db,
    };
    const t0 = new Date("2032-01-01T00:00:00.000Z");
    const first = await sendBulkComm({ ...args, now: t0 });
    expect(first.sent).toBe(1);

    // A second send with the identical content, well past the 30s dedup
    // window (an organizer genuinely clicking "resend" again later) — the
    // rolling window must not turn into a permanent "this content is burned".
    const second = await sendBulkComm({
      ...args,
      now: new Date(t0.getTime() + 60_000),
    });
    expect(second.sent, second.error ?? "expected the later resend to succeed").toBe(1);
    expect(mailer.sent).toHaveLength(2);
  });

  it("MUST-FIRE: an explicit idempotencyKey (the route's submit nonce) dedupes a replay", async () => {
    const mailer = new MemoryMailer();
    const args = {
      eventId: fixture.eventId,
      event: await eventContext(),
      recipients: [fixture.speakerIds[0]],
      subject: "Subject",
      body: "Body",
      audience: "all_speakers" as const,
      origin: "https://callboard.test",
      mailer,
      db: ctx.db,
      idempotencyKey: "compose-form-nonce-1",
    };
    const first = await sendBulkComm(args);
    expect(first.sent).toBe(1);

    const replay = await sendBulkComm(args);
    expect(replay.sent).toBe(0);
    expect(replay.error).toMatch(/already sent/i);
    expect(mailer.sent).toHaveLength(1);
  });

  it("MUST-NOT-FIRE complement: a FRESH submit nonce sends again even with identical content", async () => {
    const mailer = new MemoryMailer();
    const base = {
      eventId: fixture.eventId,
      event: await eventContext(),
      recipients: [fixture.speakerIds[0]],
      subject: "Subject",
      body: "Body",
      audience: "all_speakers" as const,
      origin: "https://callboard.test",
      mailer,
      db: ctx.db,
    };
    const first = await sendBulkComm({ ...base, idempotencyKey: "nonce-render-1" });
    expect(first.sent).toBe(1);

    // A page reload mints a NEW nonce (the route regenerates it in the
    // loader), so this is not a replay even though every other field matches.
    const second = await sendBulkComm({ ...base, idempotencyKey: "nonce-render-2" });
    expect(second.sent, second.error ?? "expected a fresh nonce to send").toBe(1);
    expect(mailer.sent).toHaveLength(2);
  });
});
