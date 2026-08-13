import { and, desc, eq, isNull } from "drizzle-orm";

import { getDb, type DB } from "~/db/client.server";
import {
  sessionRevisions,
  sessions,
  type RevisionSource,
} from "~/db/schema";

type BatchArgument = Parameters<DB["batch"]>[0];
type BatchStatement = BatchArgument[number];

export interface RevisionEditor {
  personId: string | null;
  name: string;
  source: RevisionSource;
}

/** Append one revision row per session id. Returns the inserted ids. */
export async function recordSessionRevision(input: {
  sessionIds: string[];
  title: string;
  description: string | null;
  editor: RevisionEditor;
  now?: Date;
}): Promise<string[]> {
  if (input.sessionIds.length === 0) return [];

  const db = getDb();
  const createdAt = input.now ?? new Date();
  const ids = input.sessionIds.map(() => crypto.randomUUID());
  const statements: BatchStatement[] = input.sessionIds.map((sessionId, index) =>
    db.insert(sessionRevisions).values({
      id: ids[index],
      sessionId,
      title: input.title,
      description: input.description,
      editorPersonId: input.editor.personId,
      editorName: input.editor.name,
      source: input.editor.source,
      // The schema default is second-granular. Always bind the real timestamp
      // so rapid edits remain independently sortable.
      createdAt,
    }),
  );

  await db.batch(statements as unknown as BatchArgument);
  return ids;
}

export interface SessionRevisionRow {
  id: string;
  title: string;
  description: string | null;
  editorPersonId: string | null;
  editorName: string;
  source: RevisionSource;
  createdAt: Date;
}

/** Newest first. Scoped: the session must belong to `eventId`. */
export async function listSessionRevisions(
  sessionId: string,
  eventId: string,
): Promise<SessionRevisionRow[]> {
  return getDb()
    .select({
      id: sessionRevisions.id,
      title: sessionRevisions.title,
      description: sessionRevisions.description,
      editorPersonId: sessionRevisions.editorPersonId,
      editorName: sessionRevisions.editorName,
      source: sessionRevisions.source,
      createdAt: sessionRevisions.createdAt,
    })
    .from(sessionRevisions)
    .innerJoin(sessions, eq(sessions.id, sessionRevisions.sessionId))
    .where(
      and(
        eq(sessionRevisions.sessionId, sessionId),
        eq(sessions.eventId, eventId),
        isNull(sessions.deletedAt),
      ),
    )
    .orderBy(desc(sessionRevisions.createdAt), desc(sessionRevisions.id));
}

/**
 * Restore: re-apply a past revision's content through the SAME path an admin
 * edit uses, then append a NEW revision recording the restore. Never deletes.
 */
export async function restoreSessionRevision(input: {
  revisionId: string;
  sessionId: string;
  eventId: string;
  editor: { personId: string | null; name: string };
}): Promise<{ ok: true; restoredTo: string } | { ok: false; error: string }> {
  const db = getDb();
  const revision = await db.query.sessionRevisions.findFirst({
    where: eq(sessionRevisions.id, input.revisionId),
  });
  if (!revision || revision.sessionId !== input.sessionId) {
    return { ok: false, error: "That revision does not belong to this session." };
  }

  const session = await db.query.sessions.findFirst({
    columns: { id: true },
    where: and(
      eq(sessions.id, input.sessionId),
      eq(sessions.eventId, input.eventId),
      isNull(sessions.deletedAt),
    ),
  });
  if (!session) return { ok: false, error: "That session no longer exists." };

  // A dynamic import avoids an eager module cycle: the normal edit path records
  // through this module, while restore intentionally re-enters that same path.
  const { updateSessionContent } = await import("~/lib/admin/session-edit.server");
  const restored = await updateSessionContent({
    sessionId: input.sessionId,
    eventId: input.eventId,
    title: revision.title,
    abstract: revision.description ?? "",
    editor: { ...input.editor, source: "restore" },
  });
  if (!restored.ok) return restored;

  return { ok: true, restoredTo: input.revisionId };
}
