import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { sessions } from "~/db/schema";
import { updateSessionContent } from "~/lib/admin/session-edit.server";
import {
  listSessionRevisions,
  recordSessionRevision,
  restoreSessionRevision,
} from "~/lib/admin/session-revisions.server";
import { installTestDb, type TestDbContext } from "~/test/db";
import { seedDemoFixture, type DemoFixture } from "~/test/fixtures";

const EDITOR = {
  personId: null,
  name: "History Tester",
  source: "admin_edit" as const,
};

let ctx: TestDbContext;
let fixture: DemoFixture;

beforeEach(async () => {
  ctx = installTestDb();
  fixture = await seedDemoFixture(ctx.db);
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-08-12T12:00:00.001Z"));
});

afterEach(() => {
  vi.useRealTimers();
  ctx.close();
});

describe("session revision history", () => {
  it("MUST FIRE: two attributed edits write distinct, newest-first revisions", async () => {
    const sessionId = fixture.abstractIds[2];
    await updateSessionContent({
      sessionId,
      eventId: fixture.eventId,
      title: "  First edit  ",
      abstract: "  First description  ",
      editor: EDITOR,
    });
    vi.setSystemTime(new Date("2026-08-12T12:00:00.009Z"));
    await updateSessionContent({
      sessionId,
      eventId: fixture.eventId,
      title: "Second edit",
      abstract: "Second description",
      editor: EDITOR,
    });

    const revisions = await listSessionRevisions(sessionId, fixture.eventId);
    expect(revisions).toHaveLength(2);
    expect(revisions.map((row) => row.title)).toEqual(["Second edit", "First edit"]);
    expect(new Set(revisions.map((row) => row.createdAt.getTime())).size).toBe(2);
    expect(revisions.every((row) => row.editorName === EDITOR.name)).toBe(true);
  });

  it("MUST NOT FIRE: an unattributed edit writes no revision", async () => {
    const sessionId = fixture.abstractIds[2];
    await updateSessionContent({
      sessionId,
      eventId: fixture.eventId,
      title: "Unattributed edit",
      abstract: "No history row",
    });

    expect(await listSessionRevisions(sessionId, fixture.eventId)).toEqual([]);
  });

  it("MUST FIRE: restore reapplies exact content; MUST NOT FIRE: second edit remains", async () => {
    const sessionId = fixture.abstractIds[2];
    const first = { title: "First title", description: "First description" };
    const second = { title: "Second title", description: "Second description" };
    await updateSessionContent({
      sessionId,
      eventId: fixture.eventId,
      title: first.title,
      abstract: first.description,
      editor: EDITOR,
    });
    vi.setSystemTime(new Date("2026-08-12T12:00:00.009Z"));
    await updateSessionContent({
      sessionId,
      eventId: fixture.eventId,
      title: second.title,
      abstract: second.description,
      editor: EDITOR,
    });
    const firstRevision = (await listSessionRevisions(sessionId, fixture.eventId)).at(-1)!;

    vi.setSystemTime(new Date("2026-08-12T12:00:00.017Z"));
    const restored = await restoreSessionRevision({
      revisionId: firstRevision.id,
      sessionId,
      eventId: fixture.eventId,
      editor: EDITOR,
    });
    const row = await ctx.db.query.sessions.findFirst({ where: eq(sessions.id, sessionId) });

    expect(restored).toEqual({ ok: true, restoredTo: firstRevision.id });
    expect(row?.title).toBe(first.title);
    expect(row?.description).toBe(first.description);
    expect(row?.description).not.toBe(second.description);
  });

  it("MUST FIRE on a COUNT: restore appends one row and preserves every prior id", async () => {
    const sessionId = fixture.abstractIds[2];
    for (const [index, title] of ["First", "Second"].entries()) {
      vi.setSystemTime(new Date(`2026-08-12T12:00:00.00${index + 1}Z`));
      await updateSessionContent({
        sessionId,
        eventId: fixture.eventId,
        title,
        abstract: `${title} description`,
        editor: EDITOR,
      });
    }
    const before = await listSessionRevisions(sessionId, fixture.eventId);

    vi.setSystemTime(new Date("2026-08-12T12:00:00.010Z"));
    await restoreSessionRevision({
      revisionId: before[1].id,
      sessionId,
      eventId: fixture.eventId,
      editor: EDITOR,
    });
    const after = await listSessionRevisions(sessionId, fixture.eventId);

    expect(before).toHaveLength(2);
    expect(after).toHaveLength(3);
    expect(before.every((revision) => after.some((row) => row.id === revision.id))).toBe(true);
  });

  it("MUST NOT FIRE: cross-session and cross-event revision restores are refused", async () => {
    const targetId = fixture.abstractIds[2];
    const otherId = fixture.abstractIds[3];
    const targetBefore = await ctx.db.query.sessions.findFirst({
      columns: { title: true },
      where: eq(sessions.id, targetId),
    });
    const [otherRevisionId] = await recordSessionRevision({
      sessionIds: [otherId],
      title: "Foreign content",
      description: "Must stay foreign",
      editor: EDITOR,
      now: new Date("2026-08-12T12:00:00.001Z"),
    });
    const [targetRevisionId] = await recordSessionRevision({
      sessionIds: [targetId],
      title: "Target history",
      description: "Still scoped",
      editor: EDITOR,
      now: new Date("2026-08-12T12:00:00.002Z"),
    });

    const crossSession = await restoreSessionRevision({
      revisionId: otherRevisionId,
      sessionId: targetId,
      eventId: fixture.eventId,
      editor: EDITOR,
    });
    const crossEvent = await restoreSessionRevision({
      revisionId: targetRevisionId,
      sessionId: targetId,
      eventId: "wrong-event",
      editor: EDITOR,
    });
    const targetAfter = await ctx.db.query.sessions.findFirst({
      columns: { title: true },
      where: eq(sessions.id, targetId),
    });

    expect(crossSession.ok).toBe(false);
    expect(crossEvent.ok).toBe(false);
    expect(targetAfter?.title).toBe(targetBefore?.title);
  });

  it("MUST FIRE: a linked abstract edit records both session ids", async () => {
    const abstractId = fixture.abstractIds[0];
    const programmeId = fixture.programSessionIds[0];
    const result = await updateSessionContent({
      sessionId: abstractId,
      eventId: fixture.eventId,
      title: "Shared title",
      abstract: "Shared description",
      editor: EDITOR,
    });
    const [abstractHistory, programmeHistory] = await Promise.all([
      listSessionRevisions(abstractId, fixture.eventId),
      listSessionRevisions(programmeId, fixture.eventId),
    ]);

    expect(result).toEqual({ ok: true, updatedIds: [abstractId, programmeId] });
    expect(abstractHistory).toHaveLength(1);
    expect(programmeHistory).toHaveLength(1);
    expect(abstractHistory[0]).toMatchObject({ title: "Shared title", editorName: EDITOR.name });
    expect(programmeHistory[0]).toMatchObject({ title: "Shared title", editorName: EDITOR.name });
  });
});
