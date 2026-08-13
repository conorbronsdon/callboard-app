/**
 * `GET /e/:slug/speaker-photo/:personId/:version` — the ONLY anonymous door to
 * a headshot's bytes.
 *
 * DECISIONS #57 originally said public speaker photos are not served at all,
 * because every byte in the bucket arrived under a portal privacy expectation.
 * That reasoning still stands for those bytes; this route does not overturn it,
 * it narrows it. A photo is public only when its person record carries explicit
 * consent (`people.photo_publishable`), which no migration and no backfill ever
 * sets. See the revised DECISIONS #57 for the full policy.
 *
 * Everything about who may be served lives in
 * `resolvePublicSpeakerPhotoKey` so that the rule is testable against a real
 * database rather than asserted about rendered HTML. This file is the transport:
 * resolve, fetch, respond.
 *
 * `.ts`, not `.tsx`: this route exports a loader and no component. Vite applies
 * the React Refresh transform to every `.tsx` module, and a `.tsx` route with
 * no component export breaks the client HMR runtime — which surfaces as a Vite
 * error overlay swallowing clicks on UNRELATED pages, not as an error here.
 * Every other loader-only route in this repo (`public.calendar.ts`,
 * `api.upload.download.ts`) is `.ts` for the same reason.
 *
 * The 404 path is deliberately indistinguishable across its causes — no such
 * event, no such person, person exists but has not consented, wrong version.
 * A public image endpoint that answered differently for "no consent" than for
 * "no such person" would confirm the existence of a person who chose not to be
 * shown, which is the same leak DECISIONS #58 closes for the profile page.
 */
import { getDb } from "~/db/client.server";
import {
  getPublicSpeakerEvent,
  resolvePublicSpeakerPhotoKey,
} from "~/lib/public-speakers.server";
import { getObject, publicImageResponse } from "~/lib/r2.server";
import type { Route } from "./+types/public.speaker-photo";

/** One shape for every refusal. Do not add a reason to this. */
function notFound(): never {
  throw new Response("Not found.", { status: 404 });
}

export async function loader({ params }: Route.LoaderArgs) {
  const db = getDb();

  const event = await getPublicSpeakerEvent(db, params.slug);
  if (!event) notFound();

  const key = await resolvePublicSpeakerPhotoKey(
    db,
    event.id,
    params.personId,
    params.version,
  );
  if (!key) notFound();

  const object = await getObject(key);
  if (!object) notFound();

  // Null means the stored content type is not on the image allowlist. Refusing
  // is the only safe answer on an anonymous same-origin URL.
  const response = publicImageResponse(object);
  if (!response) notFound();

  return response;
}
