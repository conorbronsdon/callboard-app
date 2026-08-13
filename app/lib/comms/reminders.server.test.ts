/**
 * The reminder job against a real database.
 *
 * The load-bearing test is "run it twice": the dedupe state is the comm_log
 * rows the job itself writes, so a second run inside the cadence must send
 * NOTHING. A dedupe tested only against a hand-built `prior` array would pass
 * even if the job never wrote the rows that array is supposed to come from.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { forms, tasks } from "~/db/schema";
import { eq } from "drizzle-orm";
import { MemoryMailer } from "~/lib/mail/mailer";
import { installTestDb, type TestDbContext } from "~/test/db";
import { CFP_FORM_ID, FIXTURE_NOW, seedDemoFixture, type DemoFixture } from "~/test/fixtures";

import { listComms } from "./comm-log.server";
import { runTaskReminders, type ReminderRunDetails } from "./reminders.server";
import { saveTemplate } from "./templates.server";

let ctx: TestDbContext;
let fixture: DemoFixture;

beforeEach(async () => {
  ctx = installTestDb();
  fixture = await seedDemoFixture(ctx.db);
});
afterEach(() => ctx.close());

const NOW = new Date(FIXTURE_NOW);

async function run(over: { mailer?: MemoryMailer; now?: Date; policy?: { windowDays?: number; cadenceDays?: number } } = {}) {
  const mailer = over.mailer ?? new MemoryMailer();
  const result = await runTaskReminders(
    { now: over.now ?? NOW, trigger: "manual" },
    {
      db: ctx.db,
      mailer,
      origin: "https://callboard.test",
      policy: over.policy,
    },
  );
  return { result, mailer, details: result.details as ReminderRunDetails };
}

describe("runTaskReminders", () => {
  it("MUST-FIRE: emails the speaker whose task is due inside the window", async () => {
    // Fixture clock is 2026-08-08. Task due offsets are +3/+10/+10/+45 days,
    // so only "Confirm your slot" (+3) is inside the default 7-day window, and
    // speaker 0 has already completed theirs — speaker 1 has not.
    const { result, mailer, details } = await run();

    expect(result.ok).toBe(true);
    expect(mailer.sent).toHaveLength(1);
    expect(mailer.sent[0].to).toBe("rina@example.com");
    expect(details.sent).toBe(1);
    expect(details.failed).toBe(0);
    expect(details.batches).toBe(1);
  });

  it("names the task, its due date and the portal link in the body", async () => {
    const { mailer } = await run();
    const message = mailer.sent[0];

    expect(message.subject).toBe("1 thing(s) left before Frontier AI Summit 2026");
    expect(message.text).toContain("Hi Rina,");
    expect(message.text).toContain("- Confirm your slot (due Tue, Aug 11, 2026)");
    expect(message.text).toContain("https://callboard.test/portal");
    expect(message.text).not.toMatch(/\{\{/);
  });

  it("MUST-FIRE: writes a comm_log row naming every task the email covered", async () => {
    await run();
    const rows = await listComms({
      eventId: fixture.eventId,
      personId: fixture.speakerIds[1],
      db: ctx.db,
    });

    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("sent");
    expect(rows[0].templateKey).toBe("task_reminder");
    expect(rows[0].meta?.taskCount).toBe(1);
    expect(Array.isArray(rows[0].meta?.taskIds)).toBe(true);
    expect((rows[0].meta?.taskIds as string[])[0]).toBeTruthy();
  });

  /* ------------------------------------------------------------- dedupe */

  it("MUST-NOT-FIRE: running it a second time inside the cadence sends nothing", async () => {
    const first = await run();
    expect(first.mailer.sent).toHaveLength(1);

    const second = await run();
    expect(second.mailer.sent).toEqual([]);
    expect(second.details.sent).toBe(0);
    expect(second.details.suppressed).toBe(1);
    expect(second.result.message).toContain("nothing due");

    // …and no second comm_log row was written either.
    const rows = await listComms({ eventId: fixture.eventId, db: ctx.db });
    expect(rows).toHaveLength(1);
  });

  it("MUST-NOT-FIRE: still silent one day later, inside the 3-day cadence", async () => {
    await run();
    const next = await run({ now: new Date(FIXTURE_NOW + 86_400_000) });
    expect(next.mailer.sent).toEqual([]);
  });

  it("MUST-FIRE: reminds again once the cadence has elapsed", async () => {
    await run();
    // 4 days later: past the 3-day cadence, and Rina's task is now overdue.
    // (The +10-day tasks have also entered the 7-day window by then, so this
    // run legitimately covers a second speaker as well.)
    const later = await run({ now: new Date(FIXTURE_NOW + 4 * 86_400_000) });

    const rina = later.mailer.sent.find((message) => message.to === "rina@example.com");
    expect(rina).toBeTruthy();
    expect(rina!.text).toContain("OVERDUE");
    expect(rina!.text).toContain("Confirm your slot");

    const logged = await listComms({
      eventId: fixture.eventId,
      personId: fixture.speakerIds[1],
      db: ctx.db,
    });
    expect(logged).toHaveLength(2);
  });

  /* -------------------------------------------------------------- gates */

  it("MUST-NOT-FIRE: a completed task is never chased", async () => {
    await ctx.db
      .update(tasks)
      .set({ status: "complete", completedAt: NOW })
      .where(eq(tasks.personId, fixture.speakerIds[1]));

    const { mailer, details } = await run();
    expect(mailer.sent).toEqual([]);
    expect(details.batches).toBe(0);
  });

  it("MUST-NOT-FIRE: a task behind a CLOSED form is not chased", async () => {
    const [openTask] = await ctx.db
      .select()
      .from(tasks)
      .where(eq(tasks.personId, fixture.speakerIds[1]));

    // Attach the soonest task to a form that has already closed.
    await ctx.db
      .update(forms)
      .set({ closesAt: new Date(FIXTURE_NOW - 86_400_000) })
      .where(eq(forms.id, CFP_FORM_ID));

    const dueSoon = (
      await ctx.db.select().from(tasks).where(eq(tasks.personId, fixture.speakerIds[1]))
    )
      .filter((row) => row.status === "pending" && row.dueAt)
      .sort((a, b) => Number(a.dueAt) - Number(b.dueAt))[0];
    expect(dueSoon).toBeTruthy();
    expect(openTask).toBeTruthy();

    await ctx.db
      .update(tasks)
      .set({ formId: CFP_FORM_ID })
      .where(eq(tasks.id, dueSoon.id));

    const { mailer } = await run();
    expect(mailer.sent).toEqual([]);
  });

  it("MUST-FIRE: the same task behind an OPEN form IS chased", async () => {
    const dueSoon = (
      await ctx.db.select().from(tasks).where(eq(tasks.personId, fixture.speakerIds[1]))
    )
      .filter((row) => row.status === "pending" && row.dueAt)
      .sort((a, b) => Number(a.dueAt) - Number(b.dueAt))[0];

    await ctx.db
      .update(forms)
      .set({ closesAt: new Date(FIXTURE_NOW + 30 * 86_400_000), status: "open" })
      .where(eq(forms.id, CFP_FORM_ID));
    await ctx.db
      .update(tasks)
      .set({ formId: CFP_FORM_ID })
      .where(eq(tasks.id, dueSoon.id));

    const { mailer } = await run();
    expect(mailer.sent).toHaveLength(1);
  });

  it("widening the window pulls in the tasks due later", async () => {
    const { mailer, details } = await run({ policy: { windowDays: 60 } });
    // Every open task across both seeded speakers, batched one email per person.
    expect(mailer.sent.length).toBeGreaterThan(1);
    expect(details.batches).toBe(mailer.sent.length);
    expect(new Set(mailer.sent.map((m) => m.to)).size).toBe(mailer.sent.length);
  });

  it("MUST-FIRE: a mailer failure is counted and logged, and the job reports not-ok", async () => {
    const failing = {
      name: "failing",
      observesDelivery: true,
      async send() {
        return { ok: false as const, error: "resend: HTTP 403 — domain not verified" };
      },
    };
    const result = await runTaskReminders(
      { now: NOW, trigger: "manual" },
      { db: ctx.db, mailer: failing, origin: "https://callboard.test" },
    );

    expect(result.ok).toBe(false);
    expect((result.details as ReminderRunDetails).failed).toBe(1);

    const rows = await listComms({ eventId: fixture.eventId, db: ctx.db });
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("failed");
    expect(rows[0].error).toContain("403");

    // A failed send must NOT count as a reminder — the speaker never got it.
    const retry = await run();
    expect(retry.mailer.sent).toHaveLength(1);
  });

  it("dry-run reports the recipients without sending or logging", async () => {
    const mailer = new MemoryMailer();
    const result = await runTaskReminders(
      { now: NOW, trigger: "manual" },
      { db: ctx.db, mailer, origin: "https://callboard.test", dryRun: true },
    );

    expect(mailer.sent).toEqual([]);
    expect(await listComms({ eventId: fixture.eventId, db: ctx.db })).toEqual([]);
    expect((result.details as ReminderRunDetails).recipients).toEqual([
      "rina@example.com (1) [dry-run]",
    ]);
  });

  it("uses the admin's edited template when there is one", async () => {
    await saveTemplate(
      fixture.eventId,
      "task_reminder",
      {
        subject: "[{{event.name}}] {{task.count}} to do",
        body: "Yo {{first_name}} — {{task.list}} — {{portal.url}}",
      },
      ctx.db,
    );

    const { mailer } = await run();
    expect(mailer.sent[0].subject).toBe(
      "[Frontier AI Summit 2026] 1 to do",
    );
    expect(mailer.sent[0].text).toContain("Yo Rina");
    expect(mailer.sent[0].text).toContain("Confirm your slot");
  });

  it("MUST-NOT-FIRE: an event with no tasks at all sends nothing and does not throw", async () => {
    await ctx.db.delete(tasks);
    const { result, mailer, details } = await run();
    expect(mailer.sent).toEqual([]);
    expect(result.ok).toBe(true);
    expect(details.candidates).toBe(0);
  });
});
