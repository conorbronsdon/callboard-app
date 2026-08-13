/**
 * Event membership scopes an organizer's global authority to a specific person.
 * Every admin door must read that boundary identically or the doors drift, as
 * the speaker page and upload API did when they carried separate checks.
 */
import { and, eq } from "drizzle-orm";

import { getDb } from "~/db/client.server";
import { eventPeople } from "~/db/schema";

export const NOT_ON_ROSTER = "That person is not on this event's roster.";

export async function isOnEventRoster(
  eventId: string,
  personId: string,
  db = getDb(),
): Promise<boolean> {
  const membership = await db.query.eventPeople.findFirst({
    where: and(eq(eventPeople.eventId, eventId), eq(eventPeople.personId, personId)),
    columns: { personId: true },
  });
  return Boolean(membership);
}
