/**
 * `GET /v1/openapi.json` — the machine-readable spec, generated from the
 * endpoint catalogue.
 *
 * UNAUTHENTICATED on purpose: an API you need a key to read the docs of is an
 * API nobody evaluates. It describes shapes, never data.
 */
import { methodNotAllowed } from "~/lib/api/auth.server";
import { apiJson } from "~/lib/api/envelope";
import { buildOpenApiDocument } from "~/lib/api/openapi";
import type { Route } from "./+types/v1.openapi";

export async function loader({ request }: Route.LoaderArgs) {
  return apiJson(buildOpenApiDocument({ origin: new URL(request.url).origin }), 200, {
    "cache-control": "public, max-age=300",
  });
}

export async function action() {
  return methodNotAllowed(["GET"]);
}
