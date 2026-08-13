/**
 * `POST /v1/event/{eventId}/sessions/{sessionId}/restore` — undo a soft delete.
 */
import { methodNotAllowed, requireApiKey } from "~/lib/api/auth.server";
import { apiError, apiJson } from "~/lib/api/envelope";
import { restoreSession } from "~/lib/api/sessions.server";
import { serializeSession } from "~/lib/api/serialize";
import type { Route } from "./+types/v1.session.restore";

export async function action({ request, params }: Route.ActionArgs) {
  if (request.method !== "POST") return methodNotAllowed(["POST"]);

  const eventId = params.eventId;
  await requireApiKey(request, { eventId, scope: "write:sessions" });

  const restored = await restoreSession(eventId, params.sessionId);
  if (!restored.ok) return apiError(404, "NotFoundError", restored.error.message);

  return apiJson(
    serializeSession(restored.value, { origin: new URL(request.url).origin }),
  );
}

export async function loader() {
  return methodNotAllowed(["POST"]);
}
