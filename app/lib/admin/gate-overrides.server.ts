import { desc, eq } from "drizzle-orm";

import { getDb } from "~/db/client.server";
import { gateOverrides } from "~/db/schema";
import type { GateOverrideKind } from "~/db/schema";

export interface GateOverrideActor {
  personId: string | null;
  name: string;
}

export async function recordGateOverride(input: {
  eventId: string;
  sessionId: string;
  kind: GateOverrideKind;
  reason: string;
  actor: GateOverrideActor;
}): Promise<void> {
  await getDb().insert(gateOverrides).values({
    eventId: input.eventId,
    sessionId: input.sessionId,
    kind: input.kind,
    reason: input.reason.trim(),
    overriddenByPersonId: input.actor.personId,
    overriddenByName: input.actor.name,
  });
}

/** Most recent override for a programme session, across all gate kinds. */
export async function latestGateOverride(sessionId: string): Promise<{
  kind: GateOverrideKind;
  reason: string;
  overriddenByName: string;
  createdAt: Date;
} | null> {
  const [row] = await getDb()
    .select({
      kind: gateOverrides.kind,
      reason: gateOverrides.reason,
      overriddenByName: gateOverrides.overriddenByName,
      createdAt: gateOverrides.createdAt,
    })
    .from(gateOverrides)
    .where(eq(gateOverrides.sessionId, sessionId))
    .orderBy(desc(gateOverrides.createdAt))
    .limit(1);
  return row ?? null;
}
