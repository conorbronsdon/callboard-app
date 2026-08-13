/**
 * DB-backed ownership checks for the authenticated upload route.
 *
 * Kept in a server-only module so route component bundles cannot retain D1
 * access when tests import the predicate directly.
 */
import { and, eq } from "drizzle-orm";

import { getDb } from "~/db/client.server";
import { people, sessionParticipants, sessions } from "~/db/schema";
import { isAdmin } from "~/lib/portal-access";
import { isOnEventRoster } from "~/lib/speakers/roster.server";

/**
 * May this person attach a file to this record?
 *
 * People and their profile assets are deployment-global, and admin authority
 * remains the global people.role. But an admin acting on another person acts
 * through an event, so that person must be on its roster, matching the admin
 * speaker page. Self-uploads are never roster-scoped.
 *
 * Sessions are event-owned. A session upload must resolve to the selected event;
 * speakers must also participate. Admins bypass participation, but never that
 * session event boundary.
 */
export async function mayAttachTo(
  viewer: { id: string; role: string },
  eventId: string,
  ownerType: "person" | "session",
  ownerId: string,
): Promise<boolean> {
  if (ownerType === "person") {
    if (ownerId === viewer.id) return true;
    if (!isAdmin(viewer)) return false;

    // Admin authority is global, but Decision #14 still requires a real owner:
    // never create upload metadata pointing at a nonexistent person id.
    const db = getDb();
    const owner = await db.query.people.findFirst({
      where: eq(people.id, ownerId),
      columns: { id: true },
    });
    if (!owner) return false;
    return isOnEventRoster(eventId, ownerId, db);
  }

  if (isAdmin(viewer)) {
    const owner = await getDb().query.sessions.findFirst({
      where: and(eq(sessions.id, ownerId), eq(sessions.eventId, eventId)),
      columns: { id: true },
    });
    return Boolean(owner);
  }

  const [owner] = await getDb()
    .select({ id: sessions.id })
    .from(sessions)
    .innerJoin(
      sessionParticipants,
      and(
        eq(sessionParticipants.sessionId, sessions.id),
        eq(sessionParticipants.personId, viewer.id),
      ),
    )
    .where(and(eq(sessions.id, ownerId), eq(sessions.eventId, eventId)))
    .limit(1);
  return Boolean(owner);
}
