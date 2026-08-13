/**
 * The read half of the informed gate: may this session go public yet?
 *
 * A session may be published when EITHER clause holds:
 *
 *   1. `speaker_informed_at IS NOT NULL` — the accept decision letter reached
 *      every speaker on the originating abstract. Written in
 *      `app/lib/review/decision-notify.server.ts` on a successful send.
 *   2. No abstract was composed into it. An organizer-created session has no
 *      decision letter that could ever be sent, so holding it would be a block
 *      with no unblock action — permanently unpublishable. This clause is what
 *      scopes the gate to sessions that actually owe somebody a letter.
 *
 * The marker deliberately lives on the COMPOSED session — the row the publish
 * path already filters — so the gate is a predicate on a row already in hand
 * rather than a reverse resolution through `composed_into_session_id`. Clause 2
 * rides the existing `sessions_composed_idx`.
 *
 * The schedule INVITE cannot serve as this marker: it requires the session to
 * already be published (`schedule-invite.server.ts`), which deadlocks. And
 * `comm_log` cannot: its row is keyed to the abstract, and `template_id` is
 * nullable `ON DELETE SET NULL`.
 */
import { inArray } from "drizzle-orm";

import { chunkForBind, type DB } from "~/db/client.server";
import { sessions } from "~/db/schema";

/**
 * Split sessions into those that may publish and those that must wait.
 *
 * `informed` means "may publish", which includes clause-2 sessions nobody was
 * ever told about because there was nobody to tell.
 */
export async function partitionByInformed(
  db: DB,
  sessionIds: readonly string[],
): Promise<{ informed: string[]; held: string[] }> {
  const informed: string[] = [];
  const held: string[] = [];

  for (const chunk of chunkForBind([...sessionIds], 1)) {
    const [rows, origins] = await Promise.all([
      db
        .select({ id: sessions.id, speakerInformedAt: sessions.speakerInformedAt })
        .from(sessions)
        .where(inArray(sessions.id, chunk)),
      db
        .select({ composedIntoSessionId: sessions.composedIntoSessionId })
        .from(sessions)
        .where(inArray(sessions.composedIntoSessionId, chunk)),
    ]);
    const withOriginatingAbstract = new Set(
      origins.flatMap((row) =>
        row.composedIntoSessionId ? [row.composedIntoSessionId] : [],
      ),
    );
    for (const row of rows) {
      const mayPublish =
        row.speakerInformedAt !== null || !withOriginatingAbstract.has(row.id);
      (mayPublish ? informed : held).push(row.id);
    }
  }

  return { informed, held };
}

export async function isSessionInformed(db: DB, sessionId: string): Promise<boolean> {
  const { informed } = await partitionByInformed(db, [sessionId]);
  return informed.includes(sessionId);
}

export async function abstractIdsForSessions(
  db: DB,
  sessionIds: readonly string[],
): Promise<string[]> {
  const abstractIds: string[] = [];
  for (const chunk of chunkForBind([...sessionIds], 1)) {
    const rows = await db
      .select({ id: sessions.id })
      .from(sessions)
      .where(inArray(sessions.composedIntoSessionId, chunk));
    abstractIds.push(...rows.map((row) => row.id));
  }
  return abstractIds;
}
