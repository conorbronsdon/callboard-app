/**
 * Portal file uploads: headshots, slides, documents.
 *
 * Proxied through the Worker (DECISIONS.md #21) and always attached to a record
 * (DECISIONS.md #14) — `uploads.owner_type`/`owner_id` are NOT NULL, so a file
 * cannot end up in the unattached "side bucket" Sessionboard's File Requests use.
 *
 * The rules live in the pure `~/lib/portal-uploads` module and are unit-tested
 * there; this file is only the part that touches R2 and D1.
 */
import { and, asc, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";

import { getDb } from "~/db/client.server";
import {
  people,
  uploadComments,
  uploads,
  type Upload,
  type UploadComment,
  type UploadPurpose,
} from "~/db/schema";
import {
  downloadHref,
  type LibraryComment,
  type LibraryVersion,
} from "~/lib/files-library";
import { canDeleteUpload } from "~/lib/portal-access";
import {
  OWNER_UPLOAD_QUOTA,
  UPLOADER_EVENT_UPLOAD_QUOTA,
  formatBytes,
  numberVersions,
  rootUploadId,
  validateUpload,
  validateUploadQuota,
  type UploadPurposeName,
} from "~/lib/portal-uploads";
import { deleteObject, putObject, uploadKey } from "~/lib/r2.server";
import { validateUploadSignature } from "~/lib/upload-signatures";

export type UploadResult = { ok: true; upload: Upload } | { ok: false; error: string };

/**
 * Which chain a new upload joins (CNT-04), or null when it starts one.
 *
 * Two ways in, in priority order:
 *  1. an explicit `priorUploadId` — but only if that row is genuinely the same
 *     slot (same event, owner and purpose). A caller passing an id from another
 *     speaker's task must not be able to graft a version onto their chain, so
 *     a mismatched prior is IGNORED rather than trusted;
 *  2. otherwise the newest existing upload with the same owner, purpose AND
 *     filename — which is what "re-upload slides.pdf against the same slot"
 *     looks like from the profile page, where no prior id is threaded through.
 *
 * Headshots are excluded: `storeUpload` deletes the previous object and row for
 * that purpose, so a chain there would point at bytes that no longer exist.
 */
async function resolveVersionRoot(input: {
  eventId: string;
  ownerType: "person" | "session";
  ownerId: string;
  purpose: UploadPurpose;
  filename: string;
  priorUploadId: string | null;
}): Promise<{ versionOf: string | null; version: number }> {
  const fresh = { versionOf: null, version: 1 };
  if (input.purpose === "headshot") return fresh;
  const db = getDb();

  const nextVersion = async (root: string) => {
    const chain = await db
      .select({ version: uploads.version })
      .from(uploads)
      .where(or(eq(uploads.id, root), eq(uploads.versionOf, root)));
    return {
      versionOf: root,
      version: chain.reduce((highest, row) => Math.max(highest, row.version), 0) + 1,
    };
  };

  if (input.priorUploadId) {
    const prior = await db.query.uploads.findFirst({
      where: eq(uploads.id, input.priorUploadId),
    });
    if (
      prior &&
      prior.eventId === input.eventId &&
      prior.ownerType === input.ownerType &&
      prior.ownerId === input.ownerId &&
      prior.purpose === input.purpose
    ) {
      return nextVersion(rootUploadId(prior));
    }
  }

  const [sameName] = await db
    .select()
    .from(uploads)
    .where(
      and(
        eq(uploads.eventId, input.eventId),
        eq(uploads.ownerType, input.ownerType),
        eq(uploads.ownerId, input.ownerId),
        eq(uploads.purpose, input.purpose),
        eq(uploads.filename, input.filename),
      ),
    )
    .orderBy(desc(uploads.version), desc(uploads.createdAt))
    .limit(1);

  return sameName ? nextVersion(rootUploadId(sameName)) : fresh;
}

/**
 * Every version of one file, oldest first. Pass any member of the chain.
 *
 * `id = root OR version_of = root` is the whole chain in one indexed read —
 * v1 stores NULL in `version_of` and is matched by the first arm.
 */
export async function listUploadVersions(anyUploadId: string): Promise<Upload[]> {
  const db = getDb();
  const row = await db.query.uploads.findFirst({ where: eq(uploads.id, anyUploadId) });
  if (!row) return [];
  const root = rootUploadId(row);
  return db
    .select()
    .from(uploads)
    .where(or(eq(uploads.id, root), eq(uploads.versionOf, root)))
    .orderBy(asc(uploads.version), asc(uploads.createdAt), asc(uploads.id));
}

/** The comment thread for a file, oldest first. Threads hang off the chain root. */
export async function listUploadComments(rootId: string): Promise<UploadComment[]> {
  return getDb()
    .select()
    .from(uploadComments)
    .where(eq(uploadComments.uploadId, rootId))
    .orderBy(asc(uploadComments.createdAt), asc(uploadComments.id));
}

/**
 * Comment on a file. `uploadId` may be any version — it is normalised to the
 * chain root so organizer and speaker read one thread, not one per version.
 *
 * Returns null when the upload is gone; the caller turns that into a 404.
 * Authorisation is the CALLER's job (`canReadUpload`) — this is the writer.
 */
export async function addUploadComment(input: {
  uploadId: string;
  author: { id: string; fullName: string | null; email: string };
  body: string;
}): Promise<UploadComment | null> {
  const body = input.body.trim().slice(0, 2000);
  if (!body) return null;
  const db = getDb();
  const target = await db.query.uploads.findFirst({ where: eq(uploads.id, input.uploadId) });
  if (!target) return null;

  const [row] = await db
    .insert(uploadComments)
    .values({
      uploadId: rootUploadId(target),
      authorId: input.author.id,
      authorName: input.author.fullName?.trim() || input.author.email,
      body,
    })
    .returning();
  return row;
}

/**
 * Store a file in R2 and record it in `uploads`.
 *
 * Validation runs first, so a rejected upload never leaves an orphaned object.
 * For a headshot this also repoints `people.headshot_key` and deletes the
 * previous object: `people.headshot_key` is the single source for "which one is
 * current", and keeping every photo a speaker ever tried is a storage leak.
 */
export async function storeUpload(input: {
  file: File;
  eventId: string;
  ownerType: "person" | "session";
  ownerId: string;
  purpose: UploadPurpose;
  uploadedById: string;
  /**
   * The upload this one supersedes (CNT-04). When the caller knows the slot's
   * current file — a task form answer holds its id — pass it and the new row
   * joins that chain as the next version.
   */
  priorUploadId?: string | null;
}): Promise<UploadResult> {
  const { file } = input;
  const contentType = file.type || "application/octet-stream";
  const problem = validateUpload({
    size: file.size,
    contentType,
    purpose: input.purpose as UploadPurposeName,
    filename: file.name,
  });
  if (problem) return { ok: false, error: problem };

  const db = getDb();
  const totals = {
    fileCount: sql<number>`count(*)`,
    totalBytes: sql<number>`coalesce(sum(${uploads.sizeBytes}), 0)`,
  };
  const [ownerRows, uploaderRows] = await Promise.all([
    db
      .select(totals)
      .from(uploads)
      .where(
        and(
          eq(uploads.eventId, input.eventId),
          eq(uploads.ownerType, input.ownerType),
          eq(uploads.ownerId, input.ownerId),
        ),
      ),
    db
      .select(totals)
      .from(uploads)
      .where(
        and(
          eq(uploads.eventId, input.eventId),
          eq(uploads.uploadedById, input.uploadedById),
        ),
      ),
  ]);

  const ownerQuotaProblem = validateUploadQuota({
    existingFiles: Number(ownerRows[0]?.fileCount ?? 0),
    existingBytes: Number(ownerRows[0]?.totalBytes ?? 0),
    incomingBytes: file.size,
    ...OWNER_UPLOAD_QUOTA,
    scopeLabel: input.ownerType,
  });
  if (ownerQuotaProblem) return { ok: false, error: ownerQuotaProblem };

  const uploaderQuotaProblem = validateUploadQuota({
    existingFiles: Number(uploaderRows[0]?.fileCount ?? 0),
    existingBytes: Number(uploaderRows[0]?.totalBytes ?? 0),
    incomingBytes: file.size,
    ...UPLOADER_EVENT_UPLOAD_QUOTA,
    scopeLabel: "event",
  });
  if (uploaderQuotaProblem) return { ok: false, error: uploaderQuotaProblem };

  const contents = await file.arrayBuffer();
  const signatureProblem = validateUploadSignature({
    contentType,
    // All supported signatures live in the first 8 KiB. Do not hand a 25 MB
    // allocation to a pure validator when a bounded view proves the same rule.
    bytes: new Uint8Array(contents, 0, Math.min(contents.byteLength, 8 * 1024)),
  });
  if (signatureProblem) return { ok: false, error: signatureProblem };

  const key = uploadKey({
    eventId: input.eventId,
    ownerType: input.ownerType,
    ownerId: input.ownerId,
    purpose: input.purpose,
    filename: file.name,
  });

  const filename = file.name.slice(-120);
  const chain = await resolveVersionRoot({
    eventId: input.eventId,
    ownerType: input.ownerType,
    ownerId: input.ownerId,
    purpose: input.purpose,
    filename,
    priorUploadId: input.priorUploadId ?? null,
  });

  await putObject(key, contents, contentType);

  let row: Upload;
  try {
    [row] = await db
      .insert(uploads)
      .values({
        eventId: input.eventId,
        ownerType: input.ownerType,
        ownerId: input.ownerId,
        purpose: input.purpose,
        key,
        filename,
        contentType,
        sizeBytes: file.size,
        uploadedById: input.uploadedById,
        versionOf: chain.versionOf,
        version: chain.version,
      })
      .returning();
  } catch (error) {
    // R2 and D1 cannot share a transaction. Compensate immediately so a failed
    // metadata write cannot strand an unowned object in the bucket.
    await deleteObject(key);
    throw error;
  }

  if (input.purpose === "headshot" && input.ownerType === "person") {
    const previous = await db.query.people.findFirst({ where: eq(people.id, input.ownerId) });
    await db.update(people).set({ headshotKey: key }).where(eq(people.id, input.ownerId));
    if (previous?.headshotKey && previous.headshotKey !== key) {
      await deleteObject(previous.headshotKey);
      await db.delete(uploads).where(eq(uploads.key, previous.headshotKey));
    }
  }

  return { ok: true, upload: row };
}

/**
 * One file's version list and comment thread, in the shapes both UIs render.
 *
 * Returns null when the id is unknown. The CALLER authorises — this helper is
 * shared by an admin surface and a speaker surface whose rules differ.
 */
export async function loadFileHistory(anyUploadId: string): Promise<{
  rootId: string;
  upload: Upload;
  versions: LibraryVersion[];
  comments: LibraryComment[];
} | null> {
  const rows = await listUploadVersions(anyUploadId);
  if (rows.length === 0) return null;
  const current = rows.find((row) => row.id === anyUploadId) ?? rows[rows.length - 1];
  const rootId = rootUploadId(current);

  // Resolve uploader names in ONE query rather than leaving the field blank:
  // "who sent this" is half of what the organizer's mirror of this list shows,
  // and a placeholder here would read as "Unknown" on a file that has an owner.
  const uploaderIds = [...new Set(rows.map((row) => row.uploadedById).filter(Boolean))];
  const uploaders = new Map<string, string>();
  if (uploaderIds.length > 0) {
    const named = await getDb()
      .select({ id: people.id, fullName: people.fullName, email: people.email })
      .from(people)
      .where(inArray(people.id, uploaderIds as string[]));
    for (const person of named) {
      uploaders.set(person.id, person.fullName?.trim() || person.email);
    }
  }

  const versions = numberVersions(
    rows.map((row) => ({ ...row, createdAt: row.createdAt.getTime() })),
  ).map((row) => ({
    id: row.id,
    version: row.version,
    isLatest: row.isLatest,
    filename: row.filename,
    contentType: row.contentType,
    sizeBytes: row.sizeBytes,
    sizeLabel: formatBytes(row.sizeBytes),
    createdAt: row.createdAt,
    uploaderName: (row.uploadedById && uploaders.get(row.uploadedById)) || "Unknown",
    href: downloadHref(row.id),
  }));

  const comments = (await listUploadComments(rootId)).map((row) => ({
    id: row.id,
    authorName: row.authorName,
    body: row.body,
    createdAt: row.createdAt.getTime(),
  }));

  return { rootId, upload: current, versions, comments };
}

/** Every upload owned by a person, newest first. */
export async function listPersonUploads(personId: string): Promise<Upload[]> {
  return getDb()
    .select()
    .from(uploads)
    .where(and(eq(uploads.ownerType, "person"), eq(uploads.ownerId, personId)))
    .orderBy(desc(uploads.createdAt))
    .limit(100);
}

/**
 * Delete an upload the person owns. Returns false when the row is missing or
 * belongs to somebody else — the route turns that into a 404, never a 500, and
 * never a cross-tenant delete.
 */
export async function deletePersonUpload(personId: string, uploadId: string): Promise<boolean> {
  const db = getDb();
  const row = await db.query.uploads.findFirst({ where: eq(uploads.id, uploadId) });
  // The shared predicate, not an inline comparison — `canDeleteUpload` is
  // unit-tested against a cross-account viewer in portal-access.test.ts.
  if (!row || !canDeleteUpload(row, { id: personId, role: "speaker" })) return false;

  await deleteObject(row.key);
  await db.delete(uploads).where(eq(uploads.id, uploadId));
  if (row.purpose === "headshot") {
    /*
     * Consent under DECISIONS #66 is global: one `photo_publishable` flag per
     * person that survives a replacement. But it is not free-standing; it
     * presumes a headshot exists. Deleting the only headshot removes the
     * artifact the consent was about, so the flag comes down with the key.
     * Otherwise a standing true would pre-arm the NEXT upload — a portal
     * re-add, an admin replace — to publish with no fresh consent act.
     * A flag with a null `headshot_key` is unservable anyway, so this only ever
     * makes an already-meaningless true honest.
     */
    await db
      .update(people)
      .set({ headshotKey: null, photoPublishable: false })
      .where(eq(people.id, personId));
  }
  return true;
}
