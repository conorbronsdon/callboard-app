/**
 * Upload policy — pure, so the rules can be unit-tested.
 *
 * These live outside `*.server.ts` on purpose: `app/lib/r2.server.ts` imports
 * `env.server.ts`, which imports `cloudflare:workers`, which vitest cannot
 * resolve. A validation rule that can only be exercised by deploying is a rule
 * nobody checks.
 *
 * ⚠️ `MAX_UPLOAD_BYTES` and the type lists intentionally mirror the constants in
 * `app/lib/r2.server.ts` (WS0's file, which this lane does not edit). They are
 * kept honest by `portal-uploads.test.ts`, which reads that file as TEXT and
 * fails if the numbers drift apart. Consolidating the two is a one-line follow-up
 * for whoever owns r2.server.ts next.
 */

/** Worker request-body cap for a proxied upload. Mirrors r2.server.ts. */
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

export const ALLOWED_IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp", "image/avif"];

export const ALLOWED_DOC_TYPES = [
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/vnd.ms-powerpoint",
  "text/plain",
  "text/markdown",
];

export type UploadPurposeName = "headshot" | "slides" | "document" | "other";

/**
 * The purpose the PUBLIC submission wizard stores its file answers under.
 *
 * Exported because two files have to agree on it: `storeSubmissionUpload`
 * (`app/lib/public-submit/draft.server.ts`) writes it, and the wizard's file
 * field states `uploadConstraintText(...)` for it. Those had drifted —
 * the field said "document" while the server stored "other" — and nothing
 * caught it because `ACCEPTED_TYPES.other` and `.document` happen to be equal
 * today. A coincidence is not a guarantee, and CNT-06's whole claim is that the
 * sentence on screen comes from the rule that enforces it.
 */
export const PUBLIC_SUBMIT_FILE_PURPOSE: UploadPurposeName = "other";

/** Which content types each purpose accepts. */
export const ACCEPTED_TYPES: Record<UploadPurposeName, string[]> = {
  headshot: ALLOWED_IMAGE_TYPES,
  slides: [...ALLOWED_DOC_TYPES, ...ALLOWED_IMAGE_TYPES],
  document: [...ALLOWED_DOC_TYPES, ...ALLOWED_IMAGE_TYPES],
  other: [...ALLOWED_DOC_TYPES, ...ALLOWED_IMAGE_TYPES],
};

/** `accept=` attribute for the file input, so the picker filters too. */
export const ACCEPT_ATTRIBUTE: Record<UploadPurposeName, string> = {
  headshot: ALLOWED_IMAGE_TYPES.join(","),
  slides: ACCEPTED_TYPES.slides.join(","),
  document: ACCEPTED_TYPES.document.join(","),
  other: ACCEPTED_TYPES.other.join(","),
};

export const HUMAN_ACCEPT: Record<UploadPurposeName, string> = {
  headshot: "JPEG, PNG, WebP or AVIF",
  slides: "PDF, PPT/PPTX, an image, or plain text",
  document: "PDF, PPT/PPTX, an image, or plain text",
  other: "PDF, PPT/PPTX, an image, or plain text",
};

/** The cap as the UI says it, from the same constant the validator rejects on. */
export const MAX_UPLOAD_MB = MAX_UPLOAD_BYTES / 1024 / 1024;

/**
 * The constraint sentence shown AT the upload control (CNT-06).
 *
 * Built from `HUMAN_ACCEPT` and `MAX_UPLOAD_BYTES` — the same two values
 * `validateUpload` rejects on — so the copy cannot drift from the enforced
 * limit. Hard-coding "up to 25 MB" in a JSX string is exactly the drift this
 * exists to prevent, and `portal-uploads.test.ts` fails if any surface does it.
 */
export function uploadConstraintText(purpose: UploadPurposeName): string {
  return `${HUMAN_ACCEPT[purpose]}, up to ${MAX_UPLOAD_MB} MB.`;
}

/**
 * Returns an error message, or null when the upload is acceptable.
 * Runs BEFORE the R2 write so a rejected file never becomes an orphaned object.
 */
export function validateUpload(input: {
  size: number;
  contentType: string;
  purpose: UploadPurposeName;
  filename: string;
}): string | null {
  if (!input.filename.trim()) return "Choose a file first.";
  if (input.size === 0) return "That file is empty.";
  if (input.size > MAX_UPLOAD_BYTES) {
    return `That file is ${(input.size / 1024 / 1024).toFixed(1)} MB. The limit is ${
      MAX_UPLOAD_BYTES / 1024 / 1024
    } MB.`;
  }
  // `image/jpeg; charset=binary` and `IMAGE/JPEG` are the same type.
  const type = input.contentType.split(";")[0].trim().toLowerCase();
  if (!ACCEPTED_TYPES[input.purpose].includes(type)) {
    return `${type || "That file type"} is not accepted here — upload ${HUMAN_ACCEPT[input.purpose]}.`;
  }
  return null;
}

/**
 * Storage-abuse limits. Both are enforced before an R2 write:
 *
 * - an owner cap stops one session/person record becoming an unbounded bucket;
 * - an uploader/event cap contains the total damage one signed-in principal can
 *   cause, including a public submitter who created an account inline.
 *
 * These are deliberately generous for legitimate conference workflows. They
 * are a storage safety net, not a substitute for edge rate limiting.
 */
export const OWNER_UPLOAD_QUOTA = {
  maxFiles: 10,
  maxBytes: 100 * 1024 * 1024,
} as const;

export const UPLOADER_EVENT_UPLOAD_QUOTA = {
  maxFiles: 50,
  maxBytes: 250 * 1024 * 1024,
} as const;

export function validateUploadQuota(input: {
  existingFiles: number;
  existingBytes: number;
  incomingBytes: number;
  maxFiles: number;
  maxBytes: number;
  scopeLabel: string;
}): string | null {
  if (input.existingFiles + 1 > input.maxFiles) {
    return `Upload limit reached for this ${input.scopeLabel}. Delete an existing file before uploading another.`;
  }
  if (input.existingBytes + input.incomingBytes > input.maxBytes) {
    return `Storage limit reached for this ${input.scopeLabel}. Delete an existing file before uploading another.`;
  }
  return null;
}

/* ------------------------------------------------------------ versions */

/**
 * The chain root for an upload. v1 stores NULL, so it IS its own root.
 *
 * Pure and shared: the route, the library and the comment writer must agree on
 * one id or a v2 comment lands on a thread nobody reads.
 */
export function rootUploadId(upload: { id: string; versionOf: string | null }): string {
  return upload.versionOf ?? upload.id;
}

export interface VersionedFile {
  id: string;
  version: number;
  isLatest: boolean;
}

/**
 * Order a chain oldest-first and mark exactly one row `Latest`.
 *
 * Sorts on the STORED `version` counter, not on `createdAt`: `uploads.created_at`
 * defaults to `unixepoch() * 1000`, so two uploads in the same second carry the
 * same timestamp and a time-ordered sort would mark Latest by row-order luck.
 * `createdAt` and `id` remain as tie-breaks for rows written before the counter
 * existed, which all default to version 1.
 */
export function numberVersions<T extends { id: string; version: number; createdAt: number }>(
  rows: T[],
): (T & VersionedFile)[] {
  const ordered = [...rows].sort(
    (a, b) => a.version - b.version || a.createdAt - b.createdAt || a.id.localeCompare(b.id),
  );
  return ordered.map((row, index) => ({
    ...row,
    isLatest: index === ordered.length - 1,
  }));
}

/**
 * Auth-gated headshot URL for portal/admin rendering
 * (`/portal/headshot/:personId`, `app/routes.ts`).
 *
 * `version` — the CURRENT headshot's `uploads.id` — rides along as a query
 * string rather than a path segment. The route itself stays keyed on
 * `personId` alone and always serves whatever `people.headshot_key` currently
 * points at (`portal.headshot.tsx`), so the query string is never read or
 * checked server-side; its only job is client-side. An `<img src>` that is
 * BYTE-IDENTICAL across a re-render is never touched by React's reconciler,
 * so the DOM node's `src` attribute never changes and the browser has no
 * reason to issue a new request for it — it keeps painting whatever it
 * already decoded, independent of any Cache-Control header. That was the
 * actual bug: `/portal/headshot/${personId}` names WHO, never WHICH photo, so
 * a replace rendered the same string as the upload it replaced. Because
 * `storeUpload` always inserts a new `uploads` row on replace (never reuses
 * an id — `app/lib/portal/uploads.server.ts`), a fresh `version` here
 * guarantees a different string every time, which is what actually forces
 * the refetch. Mirrors `publicSpeakerPhotoHref`
 * (`app/lib/public-speakers.server.ts`), which versions the same way for the
 * same reason on the public route — that one puts the id in the PATH because
 * it also has to be `immutable`-cacheable and content-addressed for an
 * anonymous visitor; this one does not, so a query string is enough.
 */
export function portalHeadshotHref(personId: string, version: string): string {
  return `/portal/headshot/${personId}?v=${version}`;
}

/** Human-readable file size for the UI. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
