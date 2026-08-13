/** Decision notification fan-out, audit rows, and commit isolation. */
import { eq, inArray } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  commLog,
  emailTemplates,
  people,
  sessionParticipants,
  sessions,
} from "~/db/schema";
import { templateKeyOf } from "~/lib/comms/comm-log.server";
import type { Mailer } from "~/lib/mail/mailer";
import { MemoryMailer } from "~/lib/mail/mailer";
import { installTestDb, type TestDbContext } from "~/test/db";
import {
  SPEAKERS,
  SUBMISSIONS,
  seedDemoFixture,
  type DemoFixture,
} from "~/test/fixtures";

import { commitQueues } from "./commit.server";

const ORIGIN = "https://callboard.test";
const ACCEPT = 2;
const SECOND_ACCEPT = 3;
const DECLINE = 5;

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

async function decisionRows() {
  const rows = await ctx.db.select().from(commLog);
  return rows.filter((row) =>
    ["decision_accept", "decision_decline"].includes(templateKeyOf(row.meta) ?? ""),
  );
}

/**
 * Bodies are asserted from what the MAILER was handed, not from the log row:
 * `comm_log` stores subject + status + facts, never message bodies, so reading a
 * body back out of `meta` would be testing a field the product does not keep.
 */
function textFor(mailer: MemoryMailer, email: string): string[] {
  return mailer.sent.filter((message) => message.to === email).map((message) => message.text ?? "");
}

describe("commit decision notifications", () => {
  it("MUST-FIRE: sends once per participant and abstract, deduping duplicate roles", async () => {
    await ctx.db
      .update(sessions)
      .set({ status: "accept_queue" })
      .where(eq(sessions.id, fixture.abstractIds[SECOND_ACCEPT]));

    // Put the same speaker on both accepted abstracts, and list that person in
    // two roles on the first one. The result must be two messages, not three.
    await ctx.db
      .delete(sessionParticipants)
      .where(eq(sessionParticipants.sessionId, fixture.abstractIds[SECOND_ACCEPT]));
    await ctx.db.insert(sessionParticipants).values([
      {
        sessionId: fixture.abstractIds[SECOND_ACCEPT],
        personId: fixture.speakerIds[ACCEPT],
        role: "speaker",
        isPrimary: true,
      },
      {
        sessionId: fixture.abstractIds[ACCEPT],
        personId: fixture.speakerIds[ACCEPT],
        role: "co_speaker",
        isPrimary: false,
      },
    ]);

    const mailer = new MemoryMailer();
    const result = await commitQueues(fixture.eventId, {
      origin: ORIGIN,
      mailer,
      db: ctx.db,
    });

    expect(result).toMatchObject({ accepted: 2, declined: 1, notified: 3, notifyFailed: 0 });
    expect(mailer.sent).toHaveLength(3);

    const rows = await decisionRows();
    expect(rows).toHaveLength(3);
    expect(await ctx.db.select().from(commLog)).toHaveLength(3);
    const accepted = rows.filter((row) => templateKeyOf(row.meta) === "decision_accept");
    const declined = rows.filter((row) => templateKeyOf(row.meta) === "decision_decline");
    expect(accepted).toHaveLength(2);
    expect(declined).toHaveLength(1);
    expect(accepted.map((row) => row.personId)).toEqual([
      fixture.speakerIds[ACCEPT],
      fixture.speakerIds[ACCEPT],
    ]);
    expect(accepted.map((row) => row.toEmail)).toEqual([
      SPEAKERS[ACCEPT].email,
      SPEAKERS[ACCEPT].email,
    ]);
    expect(declined[0]).toMatchObject({
      personId: fixture.speakerIds[DECLINE],
      toEmail: SPEAKERS[DECLINE].email,
    });

    // Two acceptances to one speaker, each naming ITS OWN talk.
    const acceptBodies = textFor(mailer, SPEAKERS[ACCEPT].email);
    expect(acceptBodies.some((body) => body.includes(SUBMISSIONS[ACCEPT][0]))).toBe(true);
    expect(acceptBodies.some((body) => body.includes(SUBMISSIONS[SECOND_ACCEPT][0]))).toBe(true);

    for (const row of rows) {
      const index = row.personId === fixture.speakerIds[DECLINE] ? DECLINE : ACCEPT;
      const sent = mailer.sent.filter((message) => message.to === row.toEmail);
      const text = [row.subject, ...sent.map((message) => message.text ?? "")].join("\n");
      // FIRST name, the same split every other send path uses — "Hi Dev,",
      // never "Hi Dev Patel,".
      const [first, last] = SPEAKERS[index].name.split(" ");
      expect(text).toContain(`Hi ${first},`);
      expect(text).not.toContain(`Hi ${first} ${last},`);
      expect(text).not.toContain("{{");
      expect(text).not.toContain("undefined");
      expect((row.meta as Record<string, unknown>).sessionId).toBeTruthy();
      // The body is not in the log — only the facts are.
      expect((row.meta as Record<string, unknown>).body).toBeUndefined();
    }
  });

  it("loads an administrator's customized decision template", async () => {
    await ctx.db.insert(emailTemplates).values({
      eventId: fixture.eventId,
      key: "decision_accept",
      name: "Custom acceptance",
      subject: "Selected: {{session.title}}",
      body: "Hello {{speaker.first_name}}, open {{portal.url}} for {{session.id}}.",
    });

    const mailer = new MemoryMailer();
    await commitQueues(fixture.eventId, { origin: ORIGIN, mailer, db: ctx.db });
    const row = (await decisionRows()).find(
      (candidate) => templateKeyOf(candidate.meta) === "decision_accept",
    );
    expect(row?.subject).toBe(`Selected: ${SUBMISSIONS[ACCEPT][0]}`);
    expect(textFor(mailer, row!.toEmail)[0]).toContain(`${ORIGIN}/portal`);
  });

  it("falls back from the stored first name to a split full name, then to the email local part", async () => {
    await ctx.db
      .update(people)
      .set({ fullName: null, firstName: null })
      .where(eq(people.id, fixture.speakerIds[ACCEPT]));

    const mailer = new MemoryMailer();
    await commitQueues(fixture.eventId, { origin: ORIGIN, mailer, db: ctx.db });
    const row = (await decisionRows()).find(
      (candidate) => templateKeyOf(candidate.meta) === "decision_accept",
    );
    const body = textFor(mailer, row!.toEmail)[0];
    expect(body).toContain(`Hi ${SPEAKERS[ACCEPT].email.split("@")[0]},`);
    expect(body).not.toContain("undefined");
  });

  it("MUST-NOT-FIRE: moving rows into queues sends nothing until commit", async () => {
    await ctx.db
      .update(sessions)
      .set({ status: "accept_queue" })
      .where(eq(sessions.id, fixture.abstractIds[3]));
    await ctx.db
      .update(sessions)
      .set({ status: "decline_queue" })
      .where(eq(sessions.id, fixture.abstractIds[4]));
    expect(await ctx.db.select().from(commLog)).toHaveLength(0);

    const committed = await commitQueues(fixture.eventId, {
      origin: ORIGIN,
      mailer: new MemoryMailer(),
      db: ctx.db,
    });
    expect(committed.notified).toBe(4);
    expect(await decisionRows()).toHaveLength(4);
  });

  it("MUST-NOT-FIRE: pending, draft, and withdrawn abstracts are never notified", async () => {
    const draftPersonId = "decision-draft-person";
    const draftId = "decision-draft-abstract";
    await ctx.db.insert(people).values({
      id: draftPersonId,
      email: "draft-only@example.test",
      fullName: "Draft Only",
    });
    await ctx.db.insert(sessions).values({
      id: draftId,
      eventId: fixture.eventId,
      friendlyId: "DRAFT-1",
      title: "A draft that is not ready",
      status: "draft",
      isAbstract: true,
    });
    await ctx.db.insert(sessionParticipants).values({
      sessionId: draftId,
      personId: draftPersonId,
      role: "speaker",
      isPrimary: true,
    });

    const result = await commitQueues(fixture.eventId, {
      origin: ORIGIN,
      mailer: new MemoryMailer(),
      db: ctx.db,
    });
    expect(result.notified).toBe(2); // queued accept + queued decline are the controls
    const rows = await decisionRows();
    expect(rows).toHaveLength(2);
    const recipients = rows.map((row) => row.toEmail);
    expect(recipients).not.toContain(SPEAKERS[3].email);
    expect(recipients).not.toContain(SPEAKERS[4].email);
    expect(recipients).not.toContain(SPEAKERS[7].email);
    expect(recipients).not.toContain("draft-only@example.test");
  });

  it("MUST-NOT-FIRE: a second empty commit adds no notification rows", async () => {
    const first = await commitQueues(fixture.eventId, {
      origin: ORIGIN,
      mailer: new MemoryMailer(),
      db: ctx.db,
    });
    expect(first.notified).toBe(2);
    const before = await ctx.db.select().from(commLog);

    const second = await commitQueues(fixture.eventId, {
      origin: ORIGIN,
      mailer: new MemoryMailer(),
      db: ctx.db,
    });
    expect(second).toMatchObject({ accepted: 0, declined: 0, notified: 0, notifyFailed: 0 });
    expect(await ctx.db.select().from(commLog)).toHaveLength(before.length);
  });

  it.each([
    [
      "returns ok:false",
      {
        name: "rejecting",
        observesDelivery: true,
        async send() {
          return { ok: false as const, error: "provider rejected" };
        },
      } satisfies Mailer,
    ],
    [
      "throws",
      {
        name: "throwing",
        observesDelivery: true,
        async send() {
          throw new Error("provider exploded");
        },
      } satisfies Mailer,
    ],
  ])("logs provider failure when the mailer %s without rolling back", async (_label, mailer) => {
    const result = await commitQueues(fixture.eventId, {
      origin: ORIGIN,
      mailer,
      db: ctx.db,
    });
    expect(result).toMatchObject({ accepted: 1, declined: 1, notified: 0, notifyFailed: 2 });

    const decided = await ctx.db
      .select({ id: sessions.id, status: sessions.status, composed: sessions.composedIntoSessionId })
      .from(sessions)
      .where(inArray(sessions.id, [fixture.abstractIds[ACCEPT], fixture.abstractIds[DECLINE]]));
    expect(decided.find((row) => row.id === fixture.abstractIds[ACCEPT])).toMatchObject({
      status: "accepted",
    });
    expect(
      decided.find((row) => row.id === fixture.abstractIds[ACCEPT])?.composed,
    ).toBeTruthy();
    expect(decided.find((row) => row.id === fixture.abstractIds[DECLINE])).toMatchObject({
      status: "declined",
      composed: null,
    });
    const rows = await decisionRows();
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.status === "failed")).toBe(true);
  });

  it("MAIL_DRIVER=console performs a real commit with zero fetch calls", async () => {
    ctx.close();
    ctx = installTestDb({ MAIL_DRIVER: "console", RESEND_API_KEY: "re_live_guard" });
    fixture = await seedDemoFixture(ctx.db);
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    const result = await commitQueues(fixture.eventId, { origin: ORIGIN, db: ctx.db });
    expect(result).toMatchObject({ notified: 2, notifyFailed: 0 });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(await decisionRows()).toHaveLength(2);
  });

  it("never invents a portal URL when no origin is available", async () => {
    const mailer = new MemoryMailer();
    const result = await commitQueues(fixture.eventId, { mailer, db: ctx.db });
    expect(result).toMatchObject({ notified: 0, notifyFailed: 2 });
    expect(mailer.sent).toHaveLength(0);
    expect(await decisionRows()).toHaveLength(0);
  });

  it("notify:false is the explicit must-not-send complement", async () => {
    const result = await commitQueues(fixture.eventId, {
      origin: ORIGIN,
      mailer: new MemoryMailer(),
      db: ctx.db,
      notify: false,
    });
    expect(result).toMatchObject({ accepted: 1, declined: 1, notified: 0, notifyFailed: 0 });
    expect(await decisionRows()).toHaveLength(0);
  });
});
