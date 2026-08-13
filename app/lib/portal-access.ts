/**
 * Ownership predicates — who may read or write which record.
 *
 * These are pure so the access rules are unit-testable in BOTH directions:
 * speaker A must be refused speaker B's task/upload (must-fire) AND must still
 * reach their own (must-not-fire). An authorisation check that has only ever
 * been tested with the owner's own id is a check nobody has tested.
 *
 * Route handlers call these; no route re-implements the comparison inline.
 */

export interface Viewer {
  id: string;
  role: "admin" | "speaker" | string;
}

export interface OwnedTask {
  personId: string;
  eventId: string;
}

export interface OwnedUpload {
  ownerType: "person" | "session" | string;
  ownerId: string;
  uploadedById: string | null;
}

export function isAdmin(viewer: Viewer): boolean {
  return viewer.role === "admin";
}

/**
 * A task belongs to exactly one person. Admins can see any task in the event;
 * everybody else only their own.
 *
 * NOTE: the event id is compared too. Two events in one deployment could
 * otherwise let a task id from event A be read while browsing event B.
 */
export function canAccessTask(task: OwnedTask, viewer: Viewer, eventId: string): boolean {
  if (task.eventId !== eventId) return false;
  if (isAdmin(viewer)) return true;
  return task.personId === viewer.id;
}

/**
 * Uploads are readable by an admin, by the person they are attached to, and by
 * whoever uploaded them (which covers a session-attached deck uploaded by a
 * co-speaker).
 */
export function canReadUpload(upload: OwnedUpload, viewer: Viewer): boolean {
  if (isAdmin(viewer)) return true;
  if (upload.ownerType === "person" && upload.ownerId === viewer.id) return true;
  if (upload.uploadedById !== null && upload.uploadedById === viewer.id) return true;
  return false;
}

/**
 * DELETING is stricter than reading: only the person the file is attached to,
 * or an admin. Being the uploader is deliberately NOT enough — otherwise a
 * co-speaker could delete the primary speaker's deck.
 */
export function canDeleteUpload(upload: OwnedUpload, viewer: Viewer): boolean {
  if (isAdmin(viewer)) return true;
  return upload.ownerType === "person" && upload.ownerId === viewer.id;
}

/** A person may only edit their own profile. Admins act through impersonation. */
export function canEditProfile(targetPersonId: string, viewer: Viewer): boolean {
  return targetPersonId === viewer.id;
}
