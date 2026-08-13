/**
 * Organizer participant membership changes for a programme session.
 *
 * DECISIONS.md #3 means linked abstract/programme rows describe one talk, so
 * non-primary roster changes are mirrored atomically while primary ownership
 * remains attached to the CFP and speaker portal record.
 */
import { and, eq, inArray, max } from "drizzle-orm";

import { getDb, type DB } from "~/db/client.server";
import {
  eventPeople,
  PARTICIPANT_ROLES,
  people,
  sessionParticipants,
  type ParticipantRole,
} from "~/db/schema";
import { resolveLinkedSession } from "~/lib/admin/session-edit.server";

type BatchArgument = Parameters<DB["batch"]>[0];
type BatchStatement = BatchArgument[number];

export const PARTICIPANT_ROLE_LABELS: Record<ParticipantRole, string> = {
  speaker: "Speaker",
  co_speaker: "Co-speaker",
  chairperson: "Chairperson",
  moderator: "Moderator",
  panelist: "Panelist",
};

function isParticipantRole(role: string): role is ParticipantRole {
  return PARTICIPANT_ROLES.some((candidate) => candidate === role);
}

export async function addSessionParticipant(input: {
  sessionId: string;
  eventId: string;
  personId: string;
  role: string;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!isParticipantRole(input.role)) {
    return { ok: false, error: "Pick a role for this speaker." };
  }
  // Bound to a local: the type-guard narrowing above does not survive into the
  // `.map()` callback that builds the insert statements.
  const role: ParticipantRole = input.role;

  const linked = await resolveLinkedSession(input.sessionId, input.eventId);
  if (!linked) return { ok: false, error: "That session no longer exists." };

  const db = getDb();
  const rosterPerson = await db
    .select({ id: people.id })
    .from(eventPeople)
    .innerJoin(people, eq(people.id, eventPeople.personId))
    .where(
      and(
        eq(eventPeople.eventId, input.eventId),
        eq(eventPeople.personId, input.personId),
      ),
    )
    .limit(1);
  if (rosterPerson.length === 0) {
    return { ok: false, error: "That person is not on this event's roster." };
  }

  const targetIds = [linked.id, ...(linked.counterpartId ? [linked.counterpartId] : [])];
  /*
   * The primary key is (session_id, person_id, ROLE), so `onConflictDoNothing`
   * alone would let the same human land on a row twice under two roles. The
   * duplicate check is therefore per person, not per (person, role) — and it is
   * evaluated per target so a pre-existing divergence between the abstract and
   * its composed twin repairs itself instead of blocking the whole write.
   */
  const alreadyOn = new Set(
    (
      await db
        .select({
          sessionId: sessionParticipants.sessionId,
          personId: sessionParticipants.personId,
        })
        .from(sessionParticipants)
        .where(
          and(
            inArray(sessionParticipants.sessionId, targetIds),
            eq(sessionParticipants.personId, input.personId),
          ),
        )
    ).map((row) => row.sessionId),
  );
  if (alreadyOn.has(input.sessionId)) {
    return { ok: false, error: "That person is already on this session." };
  }

  const pendingIds = targetIds.filter((sessionId) => !alreadyOn.has(sessionId));
  const nextOrders = await Promise.all(
    pendingIds.map(async (sessionId) => {
      const [row] = await db
        .select({ order: max(sessionParticipants.order) })
        .from(sessionParticipants)
        .where(eq(sessionParticipants.sessionId, sessionId));
      return (row?.order ?? -1) + 1;
    }),
  );
  const statements: BatchStatement[] = pendingIds.map((sessionId, index) =>
    db
      .insert(sessionParticipants)
      .values({
        sessionId,
        personId: input.personId,
        role,
        isPrimary: false,
        order: nextOrders[index],
      })
      .onConflictDoNothing(),
  );
  await db.batch(statements as unknown as BatchArgument);
  return { ok: true };
}

export async function removeSessionParticipant(input: {
  sessionId: string;
  eventId: string;
  personId: string;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const linked = await resolveLinkedSession(input.sessionId, input.eventId);
  if (!linked) return { ok: false, error: "That session no longer exists." };

  const db = getDb();
  const existing = await db
    .select({ isPrimary: sessionParticipants.isPrimary })
    .from(sessionParticipants)
    .where(
      and(
        eq(sessionParticipants.sessionId, input.sessionId),
        eq(sessionParticipants.personId, input.personId),
      ),
    );
  if (existing.length === 0) {
    return { ok: false, error: "That person is not on this session." };
  }
  // Portal ownership and the CFP record both hang off the primary participant.
  if (existing.some((row) => row.isPrimary)) {
    return {
      ok: false,
      error: "The submitting speaker cannot be removed from their own session.",
    };
  }

  const targetIds = [linked.id, ...(linked.counterpartId ? [linked.counterpartId] : [])];
  const statements: BatchStatement[] = targetIds.map((sessionId) =>
    db.delete(sessionParticipants).where(
      and(
        eq(sessionParticipants.sessionId, sessionId),
        eq(sessionParticipants.personId, input.personId),
      ),
    ),
  );
  await db.batch(statements as unknown as BatchArgument);
  return { ok: true };
}
