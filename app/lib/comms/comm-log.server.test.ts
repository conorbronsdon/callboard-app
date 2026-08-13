/**
 * Comm-log writes, both outcomes.
 *
 * PLAN.md §7 makes "comm-log row on mailer failure" binding: a provider that
 * rejects a send has to leave a trace an admin can find, otherwise a bounced
 * speaker invite looks exactly like one that was never triggered.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { commLog } from "~/db/schema";
import { installTestDb, type TestDbContext } from "~/test/db";
import { seedDemoFixture, type DemoFixture } from "~/test/fixtures";
import { MemoryMailer, type MailMessage, type MailResult, type Mailer } from "~/lib/mail/mailer";

import { listComms, recordComm, templateKeyOf, withCommLog } from "./comm-log.server";

let ctx: TestDbContext;
let fixture: DemoFixture;

beforeEach(async () => {
  ctx = installTestDb();
  fixture = await seedDemoFixture(ctx.db);
});
afterEach(() => ctx.close());

/** A mailer that always fails, the way a 403 from Resend does. */
class FailingMailer implements Mailer {
  readonly name = "failing";
  readonly observesDelivery = true;
  constructor(private readonly error = "resend: HTTP 403 — domain not verified") {}
  async send(): Promise<MailResult> {
    return { ok: false, error: this.error };
  }
}

/** A mailer that throws, which is NOT the contract but must not lose the row. */
const message = (over: Partial<MailMessage> = {}): MailMessage => ({
  to: "speaker@callboard.dev",
  subject: "Your slot at Frontier AI Summit 2026",
  text: "body",
  ...over,
});

const context = () => ({
  eventId: fixture.eventId,
  personId: fixture.speakerIds[0],
  templateKey: "schedule_invite",
  meta: { icsUid: "callboard-abc@callboard.test", icsSequence: 0 },
  db: ctx.db,
});

describe("withCommLog", () => {
  it("MUST-FIRE: a successful send writes a `sent` row with the provider id", async () => {
    const mailer = withCommLog(new MemoryMailer(), context());
    const result = await mailer.send(message());

    expect(result.ok).toBe(true);
    const rows = await listComms({ eventId: fixture.eventId, db: ctx.db });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      toEmail: "speaker@callboard.dev",
      subject: "Your slot at Frontier AI Summit 2026",
      status: "sent",
      error: null,
      templateKey: "schedule_invite",
    });
    expect(rows[0].providerMessageId).toBe(result.id);
    expect(rows[0].sentAt).not.toBeNull();
    expect(rows[0].meta).toMatchObject({ icsUid: "callboard-abc@callboard.test" });
  });

  it("MUST-FIRE: a FAILED send writes a `failed` row carrying the provider error", async () => {
    const mailer = withCommLog(new FailingMailer(), context());
    const result = await mailer.send(message());

    expect(result.ok).toBe(false);
    const rows = await listComms({ eventId: fixture.eventId, db: ctx.db });
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("failed");
    expect(rows[0].error).toContain("403");
    expect(rows[0].error).toContain("domain not verified");
    // A failure has no send time and no provider id — that is how the admin
    // view tells "attempted and rejected" from "delivered".
    expect(rows[0].sentAt).toBeNull();
    expect(rows[0].providerMessageId).toBeNull();
  });

  it("MUST-NOT-FIRE: wrapping a mailer without sending writes nothing", async () => {
    withCommLog(new MemoryMailer(), context());
    expect(await listComms({ eventId: fixture.eventId, db: ctx.db })).toEqual([]);
  });

  it("still delivers the message to the wrapped mailer unchanged", async () => {
    const inner = new MemoryMailer();
    await withCommLog(inner, context()).send(message({ subject: "unchanged" }));
    expect(inner.sent).toHaveLength(1);
    expect(inner.sent[0].subject).toBe("unchanged");
  });

  it("resolves per-message context when given a function", async () => {
    const byRecipient = (msg: MailMessage) => ({
      ...context(),
      personId: msg.to === "rina@example.com" ? fixture.speakerIds[1] : fixture.speakerIds[0],
    });
    const mailer = withCommLog(new MemoryMailer(), byRecipient);

    await mailer.send(message({ to: "rina@example.com" }));
    await mailer.send(message({ to: "speaker@callboard.dev" }));

    const rina = await listComms({
      eventId: fixture.eventId,
      personId: fixture.speakerIds[1],
      db: ctx.db,
    });
    expect(rina).toHaveLength(1);
    expect(rina[0].toEmail).toBe("rina@example.com");
  });

  it("a comm_log write failure never turns a delivered email into an error", async () => {
    // A context pointing at a person who does not exist violates the FK.
    const mailer = withCommLog(new MemoryMailer(), {
      ...context(),
      personId: "00000000-0000-4000-8000-000000000000",
    });
    await expect(mailer.send(message())).resolves.toMatchObject({ ok: true });
    expect(await listComms({ eventId: fixture.eventId, db: ctx.db })).toEqual([]);
  });
});

describe("listComms", () => {
  beforeEach(async () => {
    await recordComm(message({ to: "speaker@callboard.dev" }), { ok: true, id: "a" }, context());
    await recordComm(
      message({ to: "rina@example.com", subject: "Reminder" }),
      { ok: true, id: "b" },
      { ...context(), personId: fixture.speakerIds[1], templateKey: "task_reminder" },
    );
    await recordComm(
      message({ to: "rina@example.com", subject: "Bounced" }),
      { ok: false, error: "no such mailbox" },
      { ...context(), personId: fixture.speakerIds[1], templateKey: "task_reminder" },
    );
  });

  it("returns every row for the event, newest first", async () => {
    const rows = await listComms({ eventId: fixture.eventId, db: ctx.db });
    expect(rows).toHaveLength(3);
    expect(rows.map((row) => row.createdAt)).toEqual(
      [...rows.map((row) => row.createdAt)].sort((a, b) => b - a),
    );
  });

  it("MUST-FIRE: filters to one speaker", async () => {
    const rows = await listComms({
      eventId: fixture.eventId,
      personId: fixture.speakerIds[1],
      db: ctx.db,
    });
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.toEmail === "rina@example.com")).toBe(true);
    expect(rows.filter((row) => row.status === "failed")).toHaveLength(1);
  });

  it("MUST-NOT-FIRE: another event's log is not visible", async () => {
    expect(
      await listComms({ eventId: "ffffffff-0000-4000-8000-000000000000", db: ctx.db }),
    ).toEqual([]);
  });

  it("honours the limit", async () => {
    expect(await listComms({ eventId: fixture.eventId, limit: 2, db: ctx.db })).toHaveLength(2);
  });
});

describe("templateKeyOf", () => {
  it("MUST-FIRE on a stored key, MUST-NOT-FIRE on anything else", () => {
    expect(templateKeyOf({ templateKey: "task_reminder" })).toBe("task_reminder");
    expect(templateKeyOf({})).toBeNull();
    expect(templateKeyOf(null)).toBeNull();
    expect(templateKeyOf({ templateKey: 7 })).toBeNull();
  });
});
