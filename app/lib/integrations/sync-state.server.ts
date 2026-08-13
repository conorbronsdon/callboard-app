/**
 * `sync_state` — one row per (event, provider), holding the mirror's watermark
 * and a short run history.
 *
 * Both integrations share it: the Accelevents panel shows "last generated /
 * last pushed", and the Airtable mirror keeps its cursor here so a run picks up
 * where the last one stopped instead of re-pushing the whole event.
 *
 * The history lives in the `state` JSON rather than a new table, because
 * schema changes are orchestrator-only (AGENTS.md #4) and a capped array of the
 * last few runs is all the Integrations page displays.
 */
import { and, eq } from "drizzle-orm";

import { getDb } from "~/db/client.server";
import { syncState, type SyncProvider } from "~/db/schema";

export type SyncStateRow = typeof syncState.$inferSelect;

export interface SyncRun {
  at: string;
  ok: boolean;
  action: string;
  message: string;
  counts?: Record<string, number>;
}

/** Keep the panel readable and the row small. */
export const MAX_HISTORY = 10;

export function historyOf(row: SyncStateRow | null | undefined): SyncRun[] {
  const raw = (row?.state as { history?: unknown } | null)?.history;
  if (!Array.isArray(raw)) return [];
  return raw.filter((entry): entry is SyncRun => {
    if (!entry || typeof entry !== "object") return false;
    const run = entry as Record<string, unknown>;
    return typeof run.at === "string" && typeof run.ok === "boolean";
  });
}

export async function readSyncState(
  eventId: string,
  provider: SyncProvider,
): Promise<SyncStateRow | null> {
  const row = await getDb().query.syncState.findFirst({
    where: and(eq(syncState.eventId, eventId), eq(syncState.provider, provider)),
  });
  return row ?? null;
}

export interface RecordSyncOptions {
  eventId: string;
  provider: SyncProvider;
  run: SyncRun;
  /** New watermark, when the run advanced one. */
  cursor?: string | null;
  /** Extra provider state to merge (e.g. local id -> remote id). */
  merge?: Record<string, unknown>;
}

/**
 * Append a run and (optionally) advance the cursor.
 *
 * Read-modify-write rather than an atomic upsert: D1 has no interactive
 * transactions, and two mirror runs racing on the same event would each be
 * pushing the same rows anyway — a lost history entry is the cheapest possible
 * casualty. The cursor itself only ever moves forward on success.
 */
export async function recordSync(options: RecordSyncOptions): Promise<SyncStateRow> {
  const db = getDb();
  const existing = await readSyncState(options.eventId, options.provider);
  const history = [options.run, ...historyOf(existing)].slice(0, MAX_HISTORY);
  const state = {
    ...((existing?.state as Record<string, unknown> | null) ?? {}),
    ...(options.merge ?? {}),
    history,
  };

  if (!existing) {
    const [created] = await db
      .insert(syncState)
      .values({
        eventId: options.eventId,
        provider: options.provider,
        cursor: options.cursor ?? null,
        lastSyncedAt: options.run.ok ? new Date(options.run.at) : null,
        lastError: options.run.ok ? null : options.run.message,
        state,
      })
      .returning();
    return created;
  }

  const [updated] = await db
    .update(syncState)
    .set({
      cursor: options.cursor === undefined ? existing.cursor : options.cursor,
      lastSyncedAt: options.run.ok ? new Date(options.run.at) : existing.lastSyncedAt,
      lastError: options.run.ok ? null : options.run.message,
      state,
      updatedAt: new Date(),
    })
    .where(eq(syncState.id, existing.id))
    .returning();
  return updated;
}
