/**
 * `POST /v1/event/{eventId}/{family}/create` — one create handler for all five
 * metadata families. `write:metadata` scope; `read:metadata` does not imply it.
 */
import { methodNotAllowed, requireApiKey } from "~/lib/api/auth.server";
import { apiError, apiJson, readJsonBody } from "~/lib/api/envelope";
import { createMetadata, familyFromPath } from "~/lib/api/metadata.server";
import { serializeMetadata } from "~/lib/api/serialize";
import type { Route } from "./+types/v1.metadata.create";

export async function action({ request, params }: Route.ActionArgs) {
  if (request.method !== "POST") return methodNotAllowed(["POST"]);

  const url = new URL(request.url);
  const family = familyFromPath(url.pathname);
  if (!family) return apiError(404, "NotFoundError", "Unknown metadata family.");

  const eventId = params.eventId;
  await requireApiKey(request, { eventId, scope: "write:metadata" });

  let body: Record<string, unknown>;
  try {
    body = await readJsonBody(request);
  } catch {
    return apiError(400, "BadRequestError", "Body must be valid JSON.");
  }

  const created = await createMetadata(family, eventId, body);
  if (!created.ok) return apiError(400, "ValidationError", created.message);

  return apiJson(serializeMetadata(eventId, created.row), 201);
}

export async function loader() {
  return methodNotAllowed(["POST"]);
}
