import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  people,
  sessionParticipants,
  sessions,
  webhookDeliveries,
  webhooks,
} from "~/db/schema";
import { updateSessionContent } from "~/lib/admin/session-edit.server";
import { createSession, softDeleteSession, updateSession } from "~/lib/api/sessions.server";
import { commitQueues } from "~/lib/review/commit.server";
import { action as agendaAction } from "~/routes/admin.agenda";
import { action as contactsAction } from "~/routes/admin.contacts";
import { action as contactDetailAction } from "~/routes/admin.contacts.detail";
import { signedInPost } from "~/test/auth";
import { installTestDb, type TestDbContext } from "~/test/db";
import { seedDemoFixture, type DemoFixture } from "~/test/fixtures";

let ctx: TestDbContext;
let fixture: DemoFixture;
let agendaCounter = 0;

beforeEach(async () => {
  ctx = installTestDb();
  fixture = await seedDemoFixture(ctx.db);
  await ctx.db.insert(webhooks).values({
    id: "write-path-hook",
    url: "https://receiver.test/callboard",
    secret: "write-path-secret",
  });
  vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 204 })));
});

afterEach(() => {
  vi.unstubAllGlobals();
  ctx.close();
});

async function clearDeliveries() {
  await ctx.db.delete(webhookDeliveries);
}

async function deliveryRows() {
  return ctx.db.select().from(webhookDeliveries);
}

async function postContacts(fields: Record<string, string>) {
  const request = await signedInPost("https://x.test/admin/contacts", fixture.adminId, fields);
  return contactsAction({ request, params: {}, context: {} } as never);
}

async function postContactDetail(personId: string, fields: Record<string, string>) {
  const request = await signedInPost(
    `https://x.test/admin/contacts/${personId}`,
    fixture.adminId,
    fields,
  );
  return contactDetailAction({ request, params: { id: personId }, context: {} } as never);
}

async function postAgenda(fields: Record<string, string>) {
  const request = await signedInPost("https://x.test/admin/agenda", fixture.adminId, fields);
  return agendaAction({ request, params: {}, context: {} } as never);
}

async function addAgendaSession(options: {
  informed: boolean;
  withAbstract: boolean;
  title: string;
}): Promise<string> {
  agendaCounter += 1;
  const id = `webhook-agenda-${agendaCounter}`;
  const startsAt = new Date(Date.UTC(2035, 0, 1, agendaCounter * 2));
  await ctx.db.insert(sessions).values({
    id,
    eventId: fixture.eventId,
    friendlyId: `WH-${agendaCounter}`,
    title: options.title,
    status: "accepted",
    isAbstract: false,
    roomId: fixture.roomIds[0],
    trackId: fixture.trackIds[0],
    formatId: fixture.formatIds[0],
    startsAt,
    endsAt: new Date(startsAt.getTime() + 30 * 60_000),
    isPublic: false,
    speakerInformedAt: options.informed ? new Date() : null,
  });
  await ctx.db.insert(sessionParticipants).values({
    sessionId: id,
    personId: fixture.speakerIds[0],
    role: "speaker",
    isPrimary: true,
  });
  if (options.withAbstract) {
    await ctx.db.insert(sessions).values({
      id: `${id}-abstract`,
      eventId: fixture.eventId,
      friendlyId: `WH-ABS-${agendaCounter}`,
      title: options.title,
      status: "accepted",
      isAbstract: true,
      composedIntoSessionId: id,
    });
  }
  return id;
}

describe("session webhook write paths", () => {
  it("session.created MUST FIRE and endpoint failure MUST NOT fail the durable create", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 500 })));

    const result = await createSession(fixture.eventId, {
      title: "Webhook failure still creates this session",
      isAbstract: false,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.message);
    expect(await ctx.db.query.sessions.findFirst({ where: eq(sessions.id, result.value.id) }))
      .toBeDefined();
    expect(await deliveryRows()).toMatchObject([{
      event: "session.created",
      resourceId: result.value.id,
      status: "failed",
      attempts: 2,
    }]);
    expect((await deliveryRows())[0].lastError).toContain("HTTP 500");
  });

  it("session.updated MUST FIRE from the primary admin content editor", async () => {
    const id = "content-edit-webhook";
    await ctx.db.insert(sessions).values({
      id,
      eventId: fixture.eventId,
      title: "Before",
      status: "accepted",
      isAbstract: false,
    });

    await updateSessionContent({
      sessionId: id,
      eventId: fixture.eventId,
      title: "After",
      abstract: "Updated abstract",
    });

    expect(await deliveryRows()).toMatchObject([{
      event: "session.updated",
      resourceId: id,
      status: "success",
    }]);
  });

  it("session.deleted MUST FIRE only after soft deletion succeeds", async () => {
    const id = "deleted-webhook-session";
    await ctx.db.insert(sessions).values({
      id,
      eventId: fixture.eventId,
      title: "Delete me",
      status: "draft",
      isAbstract: false,
    });

    expect((await softDeleteSession(fixture.eventId, id)).ok).toBe(true);
    expect(await deliveryRows()).toMatchObject([{ event: "session.deleted", resourceId: id }]);
  });

  it("session.published MUST FIRE and session.updated MUST NOT FIRE for the same API write", async () => {
    const created = await createSession(fixture.eventId, {
      title: "Publish through v1 seam",
      isAbstract: false,
    });
    if (!created.ok) throw new Error(created.error.message);
    await clearDeliveries();

    expect((await updateSession(
      fixture.eventId,
      created.value.id,
      { isPublic: true },
      null,
      true,
    )).ok).toBe(true);

    const rows = await deliveryRows();
    expect(rows).toMatchObject([{ event: "session.published", resourceId: created.value.id }]);
    expect(rows.some((row) => row.event === "session.updated")).toBe(false);
  });
});

describe("contact and decision webhook write paths", () => {
  it("contact.created MUST FIRE once per imported contact", async () => {
    await postContacts({
      intent: "import-commit",
      rawCsv: "name,email\nWebhook Contact,webhook.contact@example.com",
    });
    const person = await ctx.db.query.people.findFirst({
      where: eq(people.email, "webhook.contact@example.com"),
    });
    expect(person).toBeDefined();
    expect(await deliveryRows()).toMatchObject([{
      event: "contact.created",
      resourceId: person!.id,
    }]);
  });

  it("contact.updated MUST FIRE for the people-row travel update", async () => {
    const personId = fixture.speakerIds[0];
    await postContactDetail(personId, {
      intent: "save-travel",
      travelNotes: "Arrives on Monday",
    });
    expect(await deliveryRows()).toMatchObject([{
      event: "contact.updated",
      resourceId: personId,
    }]);
  });

  it("contact.merged MUST FIRE with the survivor as resource and loser in data", async () => {
    await ctx.db.insert(people).values([
      { id: "merge-survivor", email: "survivor@example.com" },
      { id: "merge-loser", email: "loser@example.com" },
    ]);
    await postContacts({
      intent: "merge",
      primaryId: "merge-survivor",
      duplicateId: "merge-loser",
    });
    expect(await deliveryRows()).toMatchObject([{
      event: "contact.merged",
      resourceId: "merge-survivor",
    }]);
  });

  it("decision.committed MUST FIRE per transitioned row and MUST NOT repeat on re-commit", async () => {
    const first = await commitQueues(fixture.eventId, { db: ctx.db, notify: false });
    expect(first.accepted).toBe(1);
    expect(first.declined).toBe(1);
    const rows = await deliveryRows();
    expect(rows.map((row) => [row.event, row.resourceId]).sort()).toEqual([
      ["decision.committed", fixture.abstractIds[2]],
      ["decision.committed", fixture.abstractIds[5]],
    ].sort());

    await commitQueues(fixture.eventId, { db: ctx.db, notify: false });
    expect(await deliveryRows()).toHaveLength(2);
  });
});

describe("admin Agenda publication webhooks", () => {
  it("set-published MUST FIRE after an informed, conflict-free write", async () => {
    const id = await addAgendaSession({ informed: true, withAbstract: true, title: "Ready" });
    await postAgenda({ intent: "set-published", sessionId: id, published: "1", view: "list" });
    expect(await deliveryRows()).toMatchObject([{
      event: "session.published",
      resourceId: id,
    }]);
  });

  it("set-published MUST NOT FIRE when the informed gate blocks the write", async () => {
    const id = await addAgendaSession({ informed: false, withAbstract: true, title: "Held" });
    const result = await postAgenda({
      intent: "set-published",
      sessionId: id,
      published: "1",
      view: "list",
    });
    expect(result).toMatchObject({ ok: false });
    expect(await deliveryRows()).toEqual([]);
  });

  it("set-published MUST NOT FIRE when the session was already public", async () => {
    const id = await addAgendaSession({ informed: true, withAbstract: true, title: "Already live" });
    await ctx.db.update(sessions).set({ isPublic: true }).where(eq(sessions.id, id));

    await postAgenda({ intent: "set-published", sessionId: id, published: "1", view: "list" });

    expect(await deliveryRows()).toEqual([]);
  });

  it("publish-all MUST FIRE once for each gate-filtered id and MUST NOT FIRE for held ids", async () => {
    const readyA = await addAgendaSession({ informed: true, withAbstract: true, title: "Ready A" });
    const readyB = await addAgendaSession({ informed: true, withAbstract: true, title: "Ready B" });
    const held = await addAgendaSession({ informed: false, withAbstract: true, title: "Held bulk" });

    await postAgenda({ intent: "publish-all", view: "list" });

    const publishedIds = (await deliveryRows())
      .filter((row) => row.event === "session.published")
      .map((row) => row.resourceId)
      .sort();
    expect(publishedIds).toEqual([readyA, readyB].sort());
    expect(publishedIds).not.toContain(held);
  });
});
