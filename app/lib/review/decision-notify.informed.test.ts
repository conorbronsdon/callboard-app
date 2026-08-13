/**
 * The informed marker: `sessions.speaker_informed_at` is stamped on the COMPOSED
 * session when — and only when — the ACCEPT decision letter actually left the
 * building for every speaker on that abstract.
 *
 * This is the write half of the publish gate. The read half lives in
 * `app/lib/agenda/informed-gate.server.ts` and is proved in
 * `app/routes/admin.agenda.informed-gate.test.tsx`.
 *
 * Every assertion here is on a VALUE (a timestamp present or null), never on a
 * shape, because "the marker column exists" would pass on every mutation of the
 * logic that decides when to write it.
 */
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { sessionParticipants, sessions } from "~/db/schema";
import type { Mailer } from "~/lib/mail/mailer";
import { MemoryMailer } from "~/lib/mail/mailer";
import { installTestDb, type TestDbContext } from "~/test/db";
import { seedDemoFixture, type DemoFixture } from "~/test/fixtures";

import { commitQueues } from "./commit.server";

let ctx: TestDbContext;
let fixture: DemoFixture;

beforeEach(async () => {
  ctx = installTestDb();
  fixture = await seedDemoFixture(ctx.db);
});
afterEach(() => ctx.close());

/** Fixture mirrors the seed: index 2 is the only accept_queue row, 5 the only decline_queue. */
const QUEUED_ACCEPT = 2;
const QUEUED_DECLINE = 5;

const ORIGIN = "https://callboard.test";

/** Always fails, the way a 403 from Resend does. */
const failingMailer = {
  name: "failing",
  observesDelivery: true,
  async send() {
    return { ok: false as const, error: "resend: HTTP 403 — domain not verified" };
  },
} satisfies Mailer;

/** Fails for one specific address and succeeds for every other. */
function mailerFailingFor(badEmail: string): Mailer {
  return {
    name: "selective",
    observesDelivery: true,
    async send(message) {
      const to = Array.isArray(message.to) ? message.to : [message.to];
      if (to.some((address) => String(address).includes(badEmail))) {
        return { ok: false as const, error: "mailbox full" };
      }
      return { ok: true as const, id: "selective-ok" };
    },
  };
}

/** The composed programme session an accepted abstract became. */
async function composedSessionFor(abstractId: string) {
  const abstract = await ctx.db.query.sessions.findFirst({
    where: eq(sessions.id, abstractId),
  });
  if (!abstract?.composedIntoSessionId) return null;
  return (
    (await ctx.db.query.sessions.findFirst({
      where: eq(sessions.id, abstract.composedIntoSessionId),
    })) ?? null
  );
}

describe("informed marker on a successful accept letter", () => {
  it("MUST FIRE: a delivered accept letter stamps speakerInformedAt on the composed session", async () => {
    const mailer = new MemoryMailer();
    const result = await commitQueues(fixture.eventId, {
      origin: ORIGIN,
      db: ctx.db,
      mailer,
    });

    expect(result.notified).toBeGreaterThan(0);
    expect(result.notifyFailed).toBe(0);

    const composed = await composedSessionFor(fixture.abstractIds[QUEUED_ACCEPT]);
    expect(composed).not.toBeNull();
    // Assert the VALUE: a real Date, not merely "not undefined".
    expect(composed?.speakerInformedAt).toBeInstanceOf(Date);
    expect(composed?.speakerInformedAt?.getTime()).toBeGreaterThan(0);
  });

  it("MUST FIRE: a failing mailer leaves the marker NULL and reports the failure count", async () => {
    const result = await commitQueues(fixture.eventId, {
      origin: ORIGIN,
      db: ctx.db,
      mailer: failingMailer,
    });

    // The commit itself is durable regardless — only the letter failed.
    expect(result.accepted).toBe(1);
    expect(result.notified).toBe(0);
    expect(result.notifyFailed).toBeGreaterThan(0);

    const composed = await composedSessionFor(fixture.abstractIds[QUEUED_ACCEPT]);
    expect(composed).not.toBeNull();
    expect(composed?.speakerInformedAt).toBeNull();
  });

  it("MUST FIRE: one co-speaker send failing leaves the whole session uninformed", async () => {
    // Add a second speaker to the accept-queued abstract, then fail only their send.
    const abstractId = fixture.abstractIds[QUEUED_ACCEPT];
    const coSpeakerId = fixture.speakerIds[0];
    await ctx.db.insert(sessionParticipants).values({
      sessionId: abstractId,
      personId: coSpeakerId,
      role: "speaker",
      isPrimary: false,
      order: 1,
    });

    const coSpeaker = await ctx.db.query.people.findFirst({
      where: (people, { eq: equals }) => equals(people.id, coSpeakerId),
    });
    expect(coSpeaker?.email).toBeTruthy();

    const result = await commitQueues(fixture.eventId, {
      origin: ORIGIN,
      db: ctx.db,
      mailer: mailerFailingFor(coSpeaker!.email),
    });

    // One speaker WAS told, one was not — the session is not "informed".
    expect(result.notifyFailed).toBeGreaterThan(0);
    const composed = await composedSessionFor(abstractId);
    expect(composed?.speakerInformedAt).toBeNull();
  });
});

describe("informed marker is scoped to ACCEPT letters", () => {
  it("MUST NOT FIRE: a delivered decline letter marks nothing informed", async () => {
    const mailer = new MemoryMailer();
    await commitQueues(fixture.eventId, { origin: ORIGIN, db: ctx.db, mailer });

    const declined = await ctx.db.query.sessions.findFirst({
      where: eq(sessions.id, fixture.abstractIds[QUEUED_DECLINE]),
    });
    expect(declined?.status).toBe("declined");
    // A decline composes nothing, so there is no session to mark.
    expect(declined?.composedIntoSessionId).toBeNull();
    // And the decline must never stamp the abstract row either.
    expect(declined?.speakerInformedAt).toBeNull();
  });

  it("MUST FIRE: a declined-then-accepted abstract needs its OWN accept letter", async () => {
    const mailer = new MemoryMailer();
    // Round one: the decline letter goes out successfully.
    await commitQueues(fixture.eventId, { origin: ORIGIN, db: ctx.db, mailer });
    const declinedId = fixture.abstractIds[QUEUED_DECLINE];

    // Round two: the organizer changes their mind and re-queues it as an accept,
    // but the accept letter FAILS. The earlier successful decline letter must not
    // be mistaken for "the speaker has been told they're in".
    await ctx.db
      .update(sessions)
      .set({ status: "accept_queue" })
      .where(eq(sessions.id, declinedId));

    await commitQueues(fixture.eventId, {
      origin: ORIGIN,
      db: ctx.db,
      mailer: failingMailer,
    });

    const composed = await composedSessionFor(declinedId);
    expect(composed).not.toBeNull();
    expect(composed?.speakerInformedAt).toBeNull();
  });
});
