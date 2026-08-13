/**
 * R2 file storage.
 *
 * Uploads are PROXIED THROUGH THE WORKER — no presigned URLs, no SigV4. The
 * Worker request body cap is what bounds us (25 MB below), which is well past a
 * headshot or a slide deck, and it keeps auth/ownership checks in one place.
 * Every stored object gets a row in `uploads` pointing at an owner, so nothing
 * can be orphaned.
 */
import { appEnv } from "~/lib/env.server";
import type { UploadOwnerType, UploadPurpose } from "~/db/schema";

export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

export const ALLOWED_IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp", "image/avif"];
export const ALLOWED_DOC_TYPES = [
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/vnd.ms-powerpoint",
  "text/plain",
  "text/markdown",
];

/** Deterministic, collision-free, and readable in the R2 dashboard. */
export function uploadKey(input: {
  eventId: string;
  ownerType: UploadOwnerType;
  ownerId: string;
  purpose: UploadPurpose;
  filename: string;
}): string {
  const safe = input.filename.replace(/[^a-zA-Z0-9._-]/g, "_").slice(-80);
  return [
    input.eventId,
    input.ownerType,
    input.ownerId,
    input.purpose,
    `${crypto.randomUUID()}-${safe}`,
  ].join("/");
}

export function bucket(): R2Bucket {
  return appEnv().FILES;
}

export async function putObject(
  key: string,
  body: ArrayBuffer | ReadableStream | string,
  contentType: string,
): Promise<void> {
  await bucket().put(key, body, { httpMetadata: { contentType } });
}

export async function getObject(key: string): Promise<R2ObjectBody | null> {
  return bucket().get(key);
}

export async function deleteObject(key: string): Promise<void> {
  await bucket().delete(key);
}

/**
 * Turn an R2 object into a response for an ANONYMOUS, content-addressed image
 * URL. Separate from `objectResponse` on purpose — the two have different
 * threat models and must not share a default.
 *
 * Three rules this enforces that the authenticated path does not need:
 *
 *  1. The content type is re-derived from the ALLOWLIST, never echoed from
 *     stored metadata. `writeHttpMetadata` would happily hand a browser
 *     `text/html` or `image/svg+xml` if a row ever carried one, and a same-origin
 *     HTML document served under the site's own cookies is stored XSS. Anything
 *     not on the image allowlist is refused outright rather than downgraded,
 *     because a public route has no business guessing.
 *  2. `nosniff`, so a browser cannot be talked into treating the body as
 *     anything but the type on the label. The Content-Security-Policy is NOT
 *     set here: `withSecurityHeaders` in workers/app.ts overwrites it on every
 *     response, so a header written at this level would pass a unit test and
 *     never reach a visitor. The content-type allowlist above is the real
 *     protection, and `public.speaker-photo.test.ts` asserts these headers
 *     through the same middleware the Worker applies.
 *  3. `immutable` caching is only sound because the URL carries the upload id.
 *     A replacement headshot is a NEW upload id and therefore a new URL; the
 *     old URL stops resolving at the origin. See DECISIONS #57 for what that
 *     does and does not promise about already-delivered bytes.
 */
export function publicImageResponse(object: R2ObjectBody): Response | null {
  const contentType = object.httpMetadata?.contentType ?? "";
  if (!ALLOWED_IMAGE_TYPES.includes(contentType)) return null;

  return new Response(object.body, {
    headers: {
      "content-type": contentType,
      "content-disposition": "inline",
      etag: object.httpEtag,
      "x-content-type-options": "nosniff",
      "cache-control": "public, max-age=31536000, immutable",
    },
  });
}

/** Turn an R2 object into a cacheable Response for the file-serving route. */
export function objectResponse(object: R2ObjectBody, immutable = true): Response {
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("etag", object.httpEtag);
  headers.set("x-content-type-options", "nosniff");
  headers.set(
    "cache-control",
    immutable ? "public, max-age=31536000, immutable" : "private, max-age=0, must-revalidate",
  );
  return new Response(object.body, { headers });
}
