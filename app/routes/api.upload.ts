/**
 * `POST /api/upload` — the ONE authenticated upload endpoint.
 *
 * Owned by WS3, consumed by WS1b's submission wizard as well as the portal, so
 * that file handling has a single implementation of the cap, the MIME
 * allowlist, and the "every object gets an owner" rule.
 *
 * Contract
 * --------
 *   POST multipart/form-data
 *     file        (required)  the bytes
 *     ownerType   person | session
 *     ownerId     the record the file attaches to
 *     purpose     headshot | slides | document | other      (default: document)
 *   → 200 { ok: true, upload: { id, filename, contentType, sizeBytes, url } }
 *   → 400 { ok: false, error }  validation (size, type, missing field)
 *   → 401                       no session
 *   → 403 { ok: false, error }  the caller does not own `ownerId`
 *
 * Bytes are proxied through the Worker (DECISIONS.md #21) — no presigned URLs,
 * because that is what keeps this ownership check on the write path rather than
 * in a policy document.
 *
 * Read them back at `GET /api/uploads/:uploadId`, which enforces ownership again.
 */
import { eq } from "drizzle-orm";

import { getDb } from "~/db/client.server";
import { UPLOAD_PURPOSES, sessions, type UploadPurpose } from "~/db/schema";
import { requireUser } from "~/lib/auth/auth.server";
import { requireCurrentEvent } from "~/lib/event.server";
import { mayAttachTo } from "~/lib/portal/upload-access.server";
import { RATE_LIMIT_POLICIES, enforceRateLimit } from "~/lib/rate-limit.server";
import { storeUpload } from "~/lib/portal/uploads.server";
import type { Route } from "./+types/api.upload";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });

/**
 * May this person attach a file to that record?
 *
 * `person` → only yourself (or an admin). `session` → only a session you are a
 * participant on (or an admin). Without this an authenticated speaker could
 * post a file onto anybody's record, which is the IDOR this route exists to
 * prevent.
 */
export async function action({ request }: Route.ActionArgs) {
  if (request.method !== "POST") {
    return json({ ok: false, error: "Use POST." }, 405);
  }

  const person = await requireUser(request);
  const event = await requireCurrentEvent(request);

  /*
   * The limiter runs BEFORE the multipart parse on purpose: reject a flooder
   * before buffering up to 25 MB of body. That placement is the DoS posture and
   * it is why the scope cannot be the target-derived event resolved below — the
   * target is not knowable until the body has been read, which is precisely
   * what this call exists to avoid doing for an abusive caller.
   *
   * Which leaves one requirement: the scope must not be CALLER-SELECTABLE.
   * `currentEvent` honours `?event=` on every path including this one, and in
   * `rate-limit.server.ts` the scope is both part of the `(scope,
   * identifier_hash, window_start)` primary key and HMAC'd into the identifier
   * digest — a different scope string is a whole fresh bucket, not a shared
   * one. Keying on the request's event therefore handed the caller one full
   * allowance PER EVENT: exhaust `?event=a`, resend to `?event=b`, 200. The
   * multiplier is the event count, which is why the second seeded event turned
   * a dormant flaw into a live one.
   *
   * A constant scope removes the lever. Per-person flood control never needed
   * per-event buckets, and one shared bucket is strictly stricter than the
   * per-event ones it replaces.
   */
  await enforceRateLimit({
    scope: "upload",
    identifier: person.id,
    policy: RATE_LIMIT_POLICIES.apiUpload,
    message: "Too many files were uploaded. Please wait before trying again.",
  });

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return json({ ok: false, error: "Send multipart/form-data with a `file` field." }, 400);
  }

  const file = form.get("file");
  if (!(file instanceof File)) {
    return json({ ok: false, error: "No file was attached." }, 400);
  }

  const ownerTypeRaw = String(form.get("ownerType") ?? "person");
  if (ownerTypeRaw !== "person" && ownerTypeRaw !== "session") {
    return json({ ok: false, error: "ownerType must be `person` or `session`." }, 400);
  }
  const ownerId = String(form.get("ownerId") ?? "") || person.id;

  const purposeRaw = String(form.get("purpose") ?? "document");
  if (!(UPLOAD_PURPOSES as readonly string[]).includes(purposeRaw)) {
    return json(
      { ok: false, error: `purpose must be one of: ${UPLOAD_PURPOSES.join(", ")}.` },
      400,
    );
  }

  /*
   * Which event does this file BELONG to?
   *
   * This route sits outside `/admin`, so it never sees the organizer's event
   * selection: the cookie is `Path=/admin` and `currentEvent` refuses to read
   * it off a non-admin path anyway. `requireCurrentEvent` therefore always
   * resolves the DEFAULT event here.
   *
   * For a person upload that is correct and unchanged — people are
   * deployment-global, and the event is quota/context attribution
   * (upload-access.server.ts).
   *
   * For a session upload it is wrong. Sessions are event-owned, so a file for a
   * second-event session must bind to THAT event: otherwise `mayAttachTo` 403s
   * a speaker who genuinely presents at it, and any write that did get through
   * would stamp `uploads.event_id` with the wrong provenance. So the binding
   * event is derived from the TARGET rather than from the request.
   *
   * This does NOT relax anything. For a speaker the authorization that bites is
   * the participation join, which is untouched. For an admin the event equality
   * inside `mayAttachTo` was never a permission boundary — admin authority is
   * the global `people.role` and an admin could already reach any event with
   * `?event=` — it was an accident of feeding in the request's event.
   *
   * A session id that does not exist falls through to the same opaque "cannot
   * attach" 403 below. Never a distinct 404: that would confirm which ids are
   * real.
   */
  let bindingEventId = event.id;
  if (ownerTypeRaw === "session") {
    const target = await getDb().query.sessions.findFirst({
      where: eq(sessions.id, ownerId),
      columns: { eventId: true },
    });
    if (!target) {
      return json({ ok: false, error: "You cannot attach a file to that record." }, 403);
    }
    bindingEventId = target.eventId;
  }

  if (!(await mayAttachTo(person, bindingEventId, ownerTypeRaw, ownerId))) {
    return json({ ok: false, error: "You cannot attach a file to that record." }, 403);
  }

  const result = await storeUpload({
    file,
    eventId: bindingEventId,
    ownerType: ownerTypeRaw,
    ownerId,
    purpose: purposeRaw as UploadPurpose,
    uploadedById: person.id,
  });

  if (!result.ok) return json({ ok: false, error: result.error }, 400);

  return json({
    ok: true,
    upload: {
      id: result.upload.id,
      filename: result.upload.filename,
      contentType: result.upload.contentType,
      sizeBytes: result.upload.sizeBytes,
      url: `/api/uploads/${result.upload.id}`,
    },
  });
}

/** A bare GET is a mistake, not a page. Say so instead of rendering nothing. */
export async function loader() {
  return json({ ok: false, error: "POST multipart/form-data here. GET /api/uploads/:id to read." }, 405);
}
