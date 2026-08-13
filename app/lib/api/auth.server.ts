/**
 * The `/v1` auth middleware.
 *
 * Header `x-access-token`, NOT `Authorization` — that is Sessionboard's choice
 * (research/sessionboard-api.md §2) and copying it is most of what "API
 * compatible" means for a client's HTTP layer. `Authorization: Bearer <key>` is
 * accepted as a courtesy alias, because every HTTP client reaches for it first.
 *
 * Three failures, three different codes, deliberately:
 *   401 — no key, or a key that does not resolve (unknown/revoked)
 *   403 — a real key pointed at an event it was not minted for, or missing scope
 * A revoked key returning 401 rather than 403 is the honest answer: we cannot
 * distinguish it from a random string without leaking that it once existed.
 */
import { findApiKeyByPlaintext, touchApiKey, type ApiKeyRow } from "./keys.server";
import type { ApiScope } from "./scopes";
import { apiError } from "./envelope";

export const API_KEY_HEADER = "x-access-token";

export interface ApiPrincipal {
  keyId: string;
  keyName: string;
  /** Keys are minted per event (schema: `api_keys.event_id` is NOT NULL). */
  eventId: string;
  scopes: string[];
}

/** Pull the presented key out of the request, or null. */
export function readPresentedKey(request: Request): string | null {
  const direct = request.headers.get(API_KEY_HEADER);
  if (direct?.trim()) return direct.trim();

  const authorization = request.headers.get("authorization");
  const bearer = authorization?.match(/^Bearer\s+(.+)$/i);
  if (bearer?.[1]?.trim()) return bearer[1].trim();

  return null;
}

/** Resolve without throwing. Returns null for absent/unknown/revoked keys. */
export async function authenticateApiKey(request: Request): Promise<ApiKeyRow | null> {
  const presented = readPresentedKey(request);
  if (!presented) return null;
  return findApiKeyByPlaintext(presented);
}

export interface RequireApiKeyOptions {
  /** The event the route is addressing. A key for another event gets 403. */
  eventId?: string;
  /** Required scope. Scopes never cascade — see keys.server.ts. */
  scope?: ApiScope;
}

/**
 * Authenticate + authorize, or THROW a JSON Response.
 *
 * Throwing (rather than returning a union) is what makes this usable as one
 * line at the top of every handler: React Router propagates a thrown Response
 * straight to the client, so there is no path where a handler forgets to check
 * the result and serves data anyway.
 */
export async function requireApiKey(
  request: Request,
  options: RequireApiKeyOptions = {},
): Promise<ApiPrincipal> {
  const key = await authenticateApiKey(request);
  if (!key) {
    throw apiError(
      401,
      "UnauthorizedError",
      `Missing or invalid API key. Send it as the \`${API_KEY_HEADER}\` header.`,
    );
  }

  if (options.eventId && key.eventId !== options.eventId) {
    throw apiError(
      403,
      "ForbiddenError",
      "This API key was minted for a different event.",
    );
  }

  if (options.scope && !key.scopes.includes(options.scope)) {
    throw apiError(
      403,
      "ForbiddenError",
      `This API key is missing the \`${options.scope}\` scope. Scopes do not cascade.`,
    );
  }

  await touchApiKey(key);

  return {
    keyId: key.id,
    keyName: key.name,
    eventId: key.eventId,
    scopes: key.scopes,
  };
}

/** 405 with an `allow` header — a wrong verb is a client bug worth naming. */
export function methodNotAllowed(allowed: string[]): Response {
  const response = apiError(
    405,
    "MethodNotAllowedError",
    `Allowed methods: ${allowed.join(", ")}.`,
  );
  response.headers.set("allow", allowed.join(", "));
  return response;
}
