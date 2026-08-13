/**
 * `GET /api/uploads/:uploadId` — serve an uploaded file's bytes.
 *
 * Ownership is enforced HERE as well as on the write path: an R2 key is
 * guessable-ish and a signed-in speaker must not be able to walk another
 * speaker's uploads by id. `canReadUpload` is the shared predicate, unit-tested
 * both directions in `app/lib/portal-access.test.ts`.
 *
 * A refusal is 404, not 403 — "this id exists but is not yours" is itself a
 * disclosure.
 */
import { eq } from "drizzle-orm";

import { getDb } from "~/db/client.server";
import { uploads } from "~/db/schema";
import { requireUser } from "~/lib/auth/auth.server";
import { canReadUpload } from "~/lib/portal-access";
import { getObject, objectResponse } from "~/lib/r2.server";
import type { Route } from "./+types/api.upload.download";

export async function loader({ request, params }: Route.LoaderArgs) {
  const viewer = await requireUser(request);

  const row = await getDb().query.uploads.findFirst({
    where: eq(uploads.id, params.uploadId),
  });
  if (!row || !canReadUpload(row, viewer)) {
    throw new Response("Not found.", { status: 404 });
  }

  const object = await getObject(row.key);
  if (!object) throw new Response("File is missing from storage.", { status: 404 });

  // `immutable: false` — a headshot is replaced in place from the speaker's
  // point of view, and a year-long immutable cache would show the old photo.
  const response = objectResponse(object, false);
  const safeFilename = row.filename.replace(/["\\]/g, "");
  const mayRenderInline =
    row.contentType.startsWith("image/") || row.contentType === "application/pdf";
  response.headers.set(
    "content-disposition",
    `${mayRenderInline ? "inline" : "attachment"}; filename="${safeFilename}"`,
  );
  return response;
}
