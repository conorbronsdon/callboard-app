/**
 * `GET /v1/event/{eventId}/speakers/{contactId}`.
 *
 * Carries `session_ids` alongside the contact — Sessionboard needs a second
 * call (`GET /contacts/{id}/sessions`) for the same answer, and "what is this
 * person speaking at?" is the question every speaker view starts with.
 */
import { methodNotAllowed, requireApiKey } from "~/lib/api/auth.server";
import { apiError, apiJson } from "~/lib/api/envelope";
import { getSpeaker, speakerSessionIds } from "~/lib/api/speakers.server";
import { serializeContact } from "~/lib/api/serialize";
import type { Route } from "./+types/v1.speaker";

export async function loader({ request, params }: Route.LoaderArgs) {
  const eventId = params.eventId;
  await requireApiKey(request, { eventId, scope: "read:contacts" });

  const speaker = await getSpeaker(eventId, params.contactId);
  if (!speaker) return apiError(404, "NotFoundError", "Speaker not found in this event.");

  return apiJson({
    ...serializeContact(speaker, { origin: new URL(request.url).origin }),
    session_ids: await speakerSessionIds(eventId, params.contactId),
  });
}

export async function action() {
  return methodNotAllowed(["GET"]);
}
