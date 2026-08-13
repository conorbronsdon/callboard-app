/**
 * `POST /v1/event/{eventId}/speakers` and `/speakers/search` — speaker roster.
 *
 * Returns Contact objects, because speakers are a projection over contacts
 * (research/sessionboard-api.md §3). Same envelope as every other collection.
 */
import { methodNotAllowed, requireApiKey } from "~/lib/api/auth.server";
import { apiError, apiJson, envelope, parsePaging, readJsonBody } from "~/lib/api/envelope";
import { normalizeSpeakerFilters, searchSpeakers } from "~/lib/api/speakers.server";
import { serializeContact } from "~/lib/api/serialize";
import type { Route } from "./+types/v1.speakers";

export async function action({ request, params }: Route.ActionArgs) {
  if (request.method !== "POST") return methodNotAllowed(["POST"]);

  const eventId = params.eventId;
  await requireApiKey(request, { eventId, scope: "read:contacts" });

  let body: Record<string, unknown>;
  try {
    body = await readJsonBody(request);
  } catch {
    return apiError(400, "BadRequestError", "Body must be valid JSON.");
  }

  const paging = parsePaging(body);
  const filters = normalizeSpeakerFilters(body.filters);
  const { speakers, total } = await searchSpeakers(eventId, filters, paging);
  const origin = new URL(request.url).origin;

  return apiJson(
    envelope(
      speakers.map((speaker) => serializeContact(speaker, { origin })),
      total,
      paging,
    ),
  );
}

export async function loader() {
  return methodNotAllowed(["POST"]);
}
