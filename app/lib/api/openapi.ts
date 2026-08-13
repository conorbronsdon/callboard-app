/**
 * `GET /v1/openapi.json` — generated from `API_OPERATIONS`, never hand-written.
 *
 * A spec typed out by hand drifts from the routes the moment either changes.
 * This one is derived: add an operation to the catalogue and it appears in the
 * spec, on the /developers page, and in the drift test, at once.
 *
 * OpenAPI 3.1.0, matching the version Sessionboard publishes
 * (research/sessionboard-api.md §1) so the same generators consume both.
 */
import { API_OPERATIONS, METADATA_FAMILY_PATHS, type ApiOperation } from "./catalogue";
import { API_SCOPES } from "./scopes";
import { DEFAULT_PAGE_SIZE, MAX_PAGE, MAX_PAGE_SIZE } from "./envelope";

const PATH_PARAM_DESCRIPTIONS: Record<string, string> = {
  eventId: "The event's id. `GET /v1/events` returns the one your key can reach.",
  sessionId: "Session or abstract id.",
  contactId: "Contact id (a speaker is a contact).",
  family: `Metadata family: ${METADATA_FAMILY_PATHS.join(", ")}.`,
};

function pathParameters(path: string) {
  return [...path.matchAll(/\{(\w+)\}/g)].map(([, name]) => ({
    name,
    in: "path" as const,
    required: true,
    schema:
      name === "family"
        ? { type: "string", enum: [...METADATA_FAMILY_PATHS] }
        : { type: "string" },
    description: PATH_PARAM_DESCRIPTIONS[name] ?? "",
  }));
}

function operationObject(operation: ApiOperation) {
  const body =
    operation.requestExample === undefined
      ? undefined
      : {
          required: operation.method !== "GET",
          content: {
            "application/json": {
              schema: { type: "object" },
              example: operation.requestExample,
            },
          },
        };

  const responses: Record<string, unknown> = {
    "200": {
      description: "Success",
      content: {
        "application/json": {
          schema: { type: "object" },
          ...(operation.responseExample === undefined
            ? {}
            : { example: operation.responseExample }),
        },
      },
    },
    "401": { $ref: "#/components/responses/Unauthorized" },
    "403": { $ref: "#/components/responses/Forbidden" },
  };
  if (operation.path.includes("{sessionId}") || operation.path.includes("{contactId}")) {
    responses["404"] = { $ref: "#/components/responses/NotFound" };
  }
  if (operation.method === "PUT") {
    responses["409"] = { $ref: "#/components/responses/Conflict" };
  }
  if (body) responses["400"] = { $ref: "#/components/responses/BadRequest" };

  return {
    operationId: operation.operationId,
    summary: operation.summary,
    description: operation.description,
    tags: [tagFor(operation)],
    parameters: [
      ...pathParameters(operation.path),
      ...(operation.method === "GET" && !operation.path.match(/\{(sessionId|contactId)\}/)
        ? [
            {
              name: "page",
              in: "query",
              required: false,
              schema: { type: "integer", minimum: 1, maximum: MAX_PAGE, default: 1 },
            },
            {
              name: "pageSize",
              in: "query",
              required: false,
              schema: {
                type: "integer",
                minimum: 1,
                maximum: MAX_PAGE_SIZE,
                default: DEFAULT_PAGE_SIZE,
              },
            },
          ]
        : []),
    ],
    ...(body ? { requestBody: body } : {}),
    responses,
    ...(operation.scope ? { "x-required-scope": operation.scope } : {}),
  };
}

function tagFor(operation: ApiOperation): string {
  if (operation.path.includes("/sessions")) return "Sessions";
  if (operation.path.includes("/speakers")) return "Speakers";
  if (operation.path.includes("{family}")) return "Metadata";
  return "Events";
}

const ERROR_SCHEMA = {
  type: "object",
  required: ["error", "message"],
  properties: {
    error: { type: "string", example: "UnauthorizedError" },
    message: { type: "string" },
  },
};

function errorResponse(description: string) {
  return {
    description,
    content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
  };
}

export function buildOpenApiDocument(options: { origin: string }): Record<string, unknown> {
  const paths: Record<string, Record<string, unknown>> = {};

  for (const operation of API_OPERATIONS) {
    const entry = (paths[operation.path] ??= {});
    entry[operation.method.toLowerCase()] = operationObject(operation);
  }

  // The compatibility aliases: Sessionboard searches by POSTing the bare
  // collection path. Documented so a client written against their spec can see
  // it works here too.
  paths["/v1/event/{eventId}/sessions"] = {
    post: {
      ...operationObject(API_OPERATIONS.find((op) => op.operationId === "searchSessions")!),
      operationId: "searchSessionsCompat",
      summary: "Search sessions (Sessionboard-compatible alias)",
    },
  };
  paths["/v1/event/{eventId}/speakers"] = {
    post: {
      ...operationObject(API_OPERATIONS.find((op) => op.operationId === "searchSpeakers")!),
      operationId: "searchSpeakersCompat",
      summary: "Search speakers (Sessionboard-compatible alias)",
    },
  };

  return {
    openapi: "3.1.0",
    info: {
      title: "Callboard Public API",
      version: "1.0",
      description: [
        "Callboard's public API. Conventions follow Sessionboard's so an existing",
        "integration mostly ports over: `/v1` prefix, event-scoped paths, `POST`",
        "search with a filter body, a `/create` suffix for creates, soft delete +",
        "restore, and the `x-access-token` header.",
        "",
        "Two deliberate corrections: ONE response envelope everywhere",
        "(`{results, pagination}` — Sessionboard returns a different shape for its",
        "CRUD-proxy GETs), and unassigned metadata is always `null`, never `{}`.",
      ].join("\n"),
    },
    servers: [{ url: options.origin }],
    security: [{ ApiKeyAuth: [] }],
    tags: [
      { name: "Events", description: "The entry point for every integration." },
      { name: "Sessions", description: "Abstracts and programme sessions — one resource." },
      { name: "Speakers", description: "A projection over contacts." },
      { name: "Metadata", description: "Tracks, rooms, tags, formats, levels." },
    ],
    paths,
    components: {
      securitySchemes: {
        ApiKeyAuth: {
          type: "apiKey",
          in: "header",
          name: "x-access-token",
          description:
            "Mint one in Admin → API keys. The value is shown once and stored only as a SHA-256 hash. Scopes do not cascade.",
        },
      },
      schemas: {
        Error: ERROR_SCHEMA,
        Pagination: {
          type: "object",
          required: ["currentPage", "pageSize", "totalPages", "totalResults"],
          properties: {
            currentPage: { type: "integer" },
            pageSize: { type: "integer" },
            totalPages: { type: "integer" },
            totalResults: { type: "integer" },
          },
        },
      },
      responses: {
        BadRequest: errorResponse("Validation failed."),
        Unauthorized: errorResponse("Missing or invalid API key."),
        Forbidden: errorResponse("Wrong event, or the key lacks the required scope."),
        NotFound: errorResponse("No such record in this event."),
        Conflict: errorResponse("Stale `updated_at` — somebody else wrote first."),
      },
    },
    "x-scopes": [...API_SCOPES],
  };
}
