/**
 * Organizer session-content editing for the programme drill-in.
 *
 * DECISIONS.md #3 models an accepted abstract and its composed programme
 * session as two rows describing one talk, so organizer edits keep both rows
 * in step without taking ownership of scheduling or publication fields.
 */
import { and, eq, isNull } from "drizzle-orm";

import { getDb, type DB } from "~/db/client.server";
import { sessions } from "~/db/schema";
import {
  recordSessionRevision,
  type RevisionEditor,
} from "~/lib/admin/session-revisions.server";

type BatchArgument = Parameters<DB["batch"]>[0];
type BatchStatement = BatchArgument[number];

export interface LinkedSession {
  id: string;
  eventId: string;
  isAbstract: boolean;
  counterpartId: string | null;
}

export async function resolveLinkedSession(
  sessionId: string,
  eventId: string,
): Promise<LinkedSession | null> {
  const db = getDb();
  const row = await db.query.sessions.findFirst({
    columns: {
      id: true,
      eventId: true,
      isAbstract: true,
      composedIntoSessionId: true,
    },
    where: and(
      eq(sessions.id, sessionId),
      eq(sessions.eventId, eventId),
      isNull(sessions.deletedAt),
    ),
  });
  if (!row) return null;

  // An accepted abstract and the programme session composed from it are two
  // rows describing one talk (DECISIONS.md #3). An organizer edit that touched
  // only one would make the portal and the public schedule disagree.
  const counterpart = row.isAbstract
    ? row.composedIntoSessionId
      ? await db.query.sessions.findFirst({
          columns: { id: true },
          where: and(
            eq(sessions.id, row.composedIntoSessionId),
            eq(sessions.eventId, eventId),
            eq(sessions.isAbstract, false),
            isNull(sessions.deletedAt),
          ),
        })
      : null
    : await db.query.sessions.findFirst({
        columns: { id: true },
        where: and(
          eq(sessions.composedIntoSessionId, row.id),
          eq(sessions.eventId, eventId),
          eq(sessions.isAbstract, true),
          isNull(sessions.deletedAt),
        ),
      });

  return {
    id: row.id,
    eventId: row.eventId,
    isAbstract: row.isAbstract,
    counterpartId: counterpart?.id ?? null,
  };
}

export function validateSessionContent(input: {
  title: string;
  abstract: string;
}):
  | { ok: true; value: { title: string; description: string | null } }
  | { ok: false; error: string } {
  const title = input.title.trim();
  const abstract = input.abstract.trim();
  if (!title) return { ok: false, error: "Give the session a title." };
  if (title.length > 200) {
    return { ok: false, error: "Keep the title to 200 characters or fewer." };
  }
  return { ok: true, value: { title, description: abstract || null } };
}

export async function updateSessionContent(input: {
  sessionId: string;
  eventId: string;
  title: string;
  abstract: string;
  editor?: Omit<RevisionEditor, "source"> & {
    source?: RevisionEditor["source"];
  };
}): Promise<{ ok: true; updatedIds: string[] } | { ok: false; error: string }> {
  const checked = validateSessionContent(input);
  if (!checked.ok) return checked;

  const linked = await resolveLinkedSession(input.sessionId, input.eventId);
  if (!linked) return { ok: false, error: "That session no longer exists." };

  const db = getDb();
  const updatedAt = new Date();
  const ids = [linked.id, ...(linked.counterpartId ? [linked.counterpartId] : [])];
  const statements: BatchStatement[] = ids.map((id) =>
    db
      .update(sessions)
      // Placement (startsAt/endsAt/roomId/trackId/capacity) and decision state
      // (status/isPublic/publishedAt/composedIntoSessionId) are organizer-owned
      // by OTHER paths and must not be written here.
      .set({
        title: checked.value.title,
        description: checked.value.description,
        updatedAt,
      })
      .where(
        and(
          eq(sessions.id, id),
          eq(sessions.eventId, input.eventId),
          isNull(sessions.deletedAt),
        ),
      )
      .returning({ id: sessions.id }),
  );

  const results = (await db.batch(
    statements as unknown as BatchArgument,
  )) as unknown as { id: string }[][];
  const updatedIds = results.flatMap((rows) => rows.map((row) => row.id));

  if (input.editor) {
    await recordSessionRevision({
      sessionIds: updatedIds,
      title: checked.value.title,
      description: checked.value.description,
      editor: {
        ...input.editor,
        source: input.editor.source ?? "admin_edit",
      },
      now: updatedAt,
    });
  }

  return { ok: true, updatedIds };
}
