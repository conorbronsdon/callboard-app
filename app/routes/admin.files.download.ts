/**
 * `/admin/files/download` — the bulk ZIP, served from a RESOURCE route (CNT-14).
 *
 * ── Why this is its own module and not `/admin/files`'s action ──
 * It was the action on `/admin/files`, and the button returned HTTP 500 with an
 * HTML error page instead of an archive. A raw `Response` returned from a UI
 * route's action does not reach the browser in React Router 8:
 * `lib/server-runtime/server.js:117` only takes the resource-route path when the
 * LEAF matched module has no `default` export, so a document POST to a route
 * that HAS a component goes to `handleDocumentRequest` → `submit()` →
 * `convertDataStrategyResultToDataResult` (`lib/router/router.js:2505`), which
 * reads the body with `response.text()` and hands the decoded bytes back as
 * `actionData`. The archive is destroyed on the way out, and the component then
 * threw `TypeError: Cannot use 'in' operator to search for 'ok' in PK\x03\x04…`.
 * `tests/e2e/files-download.spec.ts` is the proof, in a browser, both ways.
 *
 * So: no `default` export and no `ErrorBoundary` export in this file. Adding
 * either one silently turns the ZIP back into a 500 — `admin.files.download.
 * test.ts` asserts on the module's exported keys for exactly that reason.
 *
 * Refusals redirect to `/admin/files?download=<code>` because a resource route
 * has no page to render a message into. The codes and their sentences live in
 * `~/lib/files-library` so the library and this route cannot disagree.
 */
import { redirect } from "react-router";
import { and, eq, inArray } from "drizzle-orm";

import { chunkForBind, getDb } from "~/db/client.server";
import { uploads } from "~/db/schema";
import { requireAdmin } from "~/lib/auth/auth.server";
import { currentEvent } from "~/lib/event.server";
import { getObject } from "~/lib/r2.server";
import { MAX_ZIP_BYTES, buildZip } from "~/lib/zip";
import type { Route } from "./+types/admin.files.download";

const LIBRARY = "/admin/files";

function refuse(code: string, selectedBytes?: number): Response {
  const query = new URLSearchParams({ download: code });
  if (selectedBytes !== undefined) query.set("bytes", String(selectedBytes));
  return redirect(`${LIBRARY}?${query.toString()}`);
}

export async function action({ request }: Route.ActionArgs) {
  // First statement in the route, before a single id is read: a non-admin gets
  // 403 rather than a redirect that would tell them the library exists.
  await requireAdmin(request);
  const event = await currentEvent(request);
  if (!event) return refuse("foreign");

  const form = await request.formData();
  const ids = [...new Set(form.getAll("uploadIds").map(String).filter(Boolean))];
  if (ids.length === 0) return refuse("empty");

  /*
   * D1 caps a prepared statement at 100 bound parameters (MAX_BOUND_PARAMS).
   * The library renders up to 500 chains and every one carries a checkbox, so
   * an organizer ticking ~100 files sent a 101-parameter statement and the
   * download failed with `D1_ERROR: too many SQL variables` before a single R2
   * read. Chunked, each statement is one event id plus at most
   * BOUND_PARAM_BUDGET ids. Asserted on the WIRE in
   * `admin.files.download.bound-params.test.ts` — a row-count assertion cannot
   * see this, because the node:sqlite stand-in accepts ~32k parameters.
   */
  const db = getDb();
  const rows = (
    await Promise.all(
      chunkForBind(ids, 1).map((chunk) =>
        db
          .select()
          .from(uploads)
          .where(and(eq(uploads.eventId, event.id), inArray(uploads.id, chunk))),
      ),
    )
  ).flat();
  if (rows.length === 0) return refuse("foreign");

  // Refuse on the DECLARED sizes before fetching a single object: the point of
  // the cap is not to allocate the memory in the first place.
  const total = rows.reduce((sum, row) => sum + row.sizeBytes, 0);
  if (total > MAX_ZIP_BYTES) return refuse("too-large", total);

  const entries: { name: string; bytes: Uint8Array }[] = [];
  for (const row of rows) {
    const object = await getObject(row.key);
    if (!object) continue;
    entries.push({ name: row.filename, bytes: new Uint8Array(await object.arrayBuffer()) });
  }
  if (entries.length === 0) return refuse("missing");

  const archive = buildZip(entries);
  // `.buffer` because `BodyInit` takes an ArrayBuffer, not a typed-array view.
  // `buildZip` allocates its own exact-size buffer, so this is the whole zip.
  return new Response(archive.buffer as ArrayBuffer, {
    headers: {
      "content-type": "application/zip",
      "content-length": String(archive.byteLength),
      "content-disposition": 'attachment; filename="callboard-files.zip"',
      "x-content-type-options": "nosniff",
      "cache-control": "private, no-store",
    },
  });
}
