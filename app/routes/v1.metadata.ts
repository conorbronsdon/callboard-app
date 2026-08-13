/**
 * `GET | POST /v1/event/{eventId}/{tracks|rooms|tags|formats|levels}`.
 *
 * ONE module behind five registered paths (app/routes.ts). The paths are
 * registered STATICALLY rather than as `:family` so route matching can never
 * shadow `/sessions` or `/speakers` — and the handler reads the family back off
 * the pathname, which is the only thing that varies.
 *
 * GET lists; POST searches with `filters.text`. Both return the same envelope.
 */
import { methodNotAllowed, requireApiKey } from "~/lib/api/auth.server";
import { apiError, apiJson, envelope, parsePaging, readJsonBody } from "~/lib/api/envelope";
import {
  familyFromPath,
  listMetadata,
  normalizeMetadataFilters,
} from "~/lib/api/metadata.server";
import { serializeMetadata } from "~/lib/api/serialize";
import type { Route } from "./+types/v1.metadata";

export async function loader({ request, params }: Route.LoaderArgs) {
  const url = new URL(request.url);
  const family = familyFromPath(url.pathname);
  if (!family) return apiError(404, "NotFoundError", "Unknown metadata family.");

  const eventId = params.eventId;
  await requireApiKey(request, { eventId, scope: "read:metadata" });

  const paging = parsePaging({
    page: url.searchParams.get("page"),
    pageSize: url.searchParams.get("pageSize") ?? url.searchParams.get("page_size"),
  });
  const filters = normalizeMetadataFilters({ text: url.searchParams.get("text") });

  const { rows, total } = await listMetadata(family, eventId, filters, paging);
  return apiJson(
    envelope(
      rows.map((row) => serializeMetadata(eventId, row)),
      total,
      paging,
    ),
  );
}

export async function action({ request, params }: Route.ActionArgs) {
  if (request.method !== "POST") return methodNotAllowed(["GET", "POST"]);

  const url = new URL(request.url);
  const family = familyFromPath(url.pathname);
  if (!family) return apiError(404, "NotFoundError", "Unknown metadata family.");

  const eventId = params.eventId;
  await requireApiKey(request, { eventId, scope: "read:metadata" });

  let body: Record<string, unknown>;
  try {
    body = await readJsonBody(request);
  } catch {
    return apiError(400, "BadRequestError", "Body must be valid JSON.");
  }

  const paging = parsePaging(body);
  const filters = normalizeMetadataFilters(body.filters);
  const { rows, total } = await listMetadata(family, eventId, filters, paging);

  return apiJson(
    envelope(
      rows.map((row) => serializeMetadata(eventId, row)),
      total,
      paging,
    ),
  );
}
