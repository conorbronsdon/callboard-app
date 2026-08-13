/**
 * The MCP catalogue is data plus pure handlers, separate from transport setup.
 * That prevents protocol plumbing from becoming the only way to exercise a
 * tool: tests can drive the exact schemas and handlers with an injected HTTP
 * client, including auth failures that must never reach the network.
 */
import { z } from "zod";

import {
  CallboardApiError,
  CallboardEventResolutionError,
  type CallboardClient,
} from "./client";
import { compactSession, compactSpeaker, toolJson } from "./format";

export type ToolResult = {
  content: [{ type: "text"; text: string }];
  isError?: boolean;
};

export type ToolScope =
  | "read:events"
  | "read:sessions"
  | "write:sessions"
  | "read:contacts"
  | "read:metadata"
  | null;

export interface ToolAnnotations {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  openWorldHint: boolean;
  idempotentHint: boolean;
}

type ToolSchema = z.ZodObject<z.ZodRawShape>;

export interface ToolDefinition {
  name: string;
  title: string;
  description: string;
  inputSchema: ToolSchema;
  annotations: ToolAnnotations;
  scope: ToolScope;
  handler: (
    input: Record<string, unknown>,
    ctx: { client: CallboardClient },
  ) => Promise<ToolResult>;
}

const READ_ANNOTATIONS: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  openWorldHint: true,
  idempotentHint: true,
};

const WRITE_ANNOTATIONS: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  openWorldHint: false,
  idempotentHint: false,
};

const EVENT_ID = z
  .string()
  .min(1)
  .optional()
  .describe("Event id. Omit it to use the event this API key was minted for.");

const LIMIT_25 = z.number().int().min(1).max(100).default(25).describe("Maximum rows, 1-100.");
const PAGE = z.number().int().min(1).max(999).default(1).describe("One-based result page.");
const SESSION_STATUS = z.enum([
  "draft",
  "pending",
  "accept_queue",
  "accepted",
  "decline_queue",
  "declined",
  "withdrawn",
]);

function defineTool<S extends ToolSchema>(
  definition: Omit<ToolDefinition, "inputSchema" | "handler"> & { inputSchema: S },
  handler: (input: z.output<S>, ctx: { client: CallboardClient }) => Promise<ToolResult>,
): ToolDefinition {
  return {
    ...definition,
    handler: (input, ctx) => handler(definition.inputSchema.parse(input), ctx),
  };
}

async function eventId(input: { event_id?: string }, client: CallboardClient): Promise<string> {
  return input.event_id ?? client.resolveEventId();
}

function errorText(text: string): ToolResult {
  return { ...toolJson({ error: text }), isError: true };
}

async function runTool(
  scope: ToolScope,
  client: CallboardClient,
  action: () => Promise<ToolResult>,
): Promise<ToolResult> {
  if (scope !== null && client.apiKey === null) {
    return errorText(
      `No Callboard API key presented. Send it as the 'x-access-token' header (or 'Authorization: Bearer <key>') on the MCP endpoint. This tool needs the '${scope}' scope.`,
    );
  }

  try {
    return await action();
  } catch (error) {
    if (error instanceof CallboardEventResolutionError) {
      return errorText(
        `${error.message} Keys can be managed at ${client.origin}/admin/api-keys.`,
      );
    }
    if (error instanceof CallboardApiError && error.status === 401) {
      return errorText(
        `Callboard rejected the presented API key. Send a current key as the 'x-access-token' header (or 'Authorization: Bearer <key>'). This tool needs the '${scope}' scope.`,
      );
    }
    if (error instanceof CallboardApiError && error.status === 403) {
      return errorText(
        `Callboard refused this request. The key must be minted for this event with the '${scope}' scope. Mint or update a key at ${client.origin}/admin/api-keys.`,
      );
    }
    if (error instanceof CallboardApiError) {
      return errorText(`Callboard API request failed with HTTP ${error.status}.`);
    }
    /*
     * An unexpected throw still has to reach the agent as a readable result
     * rather than a bare protocol error, and a generic sentence is not enough
     * to act on: the first live deployment of this server returned exactly that
     * sentence for every tool, and the message it was hiding named the cause in
     * six words. The upstream key never appears in these messages — it is only
     * ever a request header — so echoing the failure text leaks nothing.
     */
    console.error("Callboard MCP tool failure", error);
    const detail = error instanceof Error ? error.message : String(error);
    return errorText(`The Callboard tool failed before it could return a result: ${detail}`);
  }
}

const listEvents = defineTool(
  {
    name: "list_events",
    title: "List events",
    description: "Return the one event this event-scoped API key can reach.",
    inputSchema: z.object({}),
    annotations: READ_ANNOTATIONS,
    scope: "read:events",
  },
  async (_input, { client }) =>
    runTool("read:events", client, async () => {
      const response = await client.listEvents();
      return toolJson({
        results: response.results.map((record) => ({
          id: record.id,
          name: record.name,
          slug: record.slug ?? null,
          timezone: record.timezone ?? null,
        })),
        pagination: response.pagination,
      });
    }),
);

const getSchedule = defineTool(
  {
    name: "get_schedule",
    title: "Get schedule",
    description:
      "List programme sessions in start-time order. Optional day filtering is applied locally to the fetched page. Omit `event_id` to use the event this API key was minted for.",
    inputSchema: z.object({
      event_id: EVENT_ID,
      track: z.string().min(1).optional().describe("Track id or exact name."),
      day: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .refine((value) => !Number.isNaN(Date.parse(`${value}T00:00:00Z`)), "Invalid ISO date")
        .optional()
        .describe("ISO date YYYY-MM-DD. Unscheduled rows are excluded when set."),
      limit: z.number().int().min(1).max(100).default(50).describe("Maximum rows, 1-100."),
    }),
    annotations: READ_ANNOTATIONS,
    scope: "read:sessions",
  },
  async (input, { client }) =>
    runTool("read:sessions", client, async () => {
      const id = await eventId(input, client);
      const filters: Record<string, unknown> = { is_abstract: false };
      if (input.track) filters.track = input.track;
      const response = await client.searchSessions(id, {
        filters,
        sort: { order: "startsAt", sort: "asc" },
        page: 1,
        pageSize: 100,
      });
      const fetched = response.results.length;
      const matching = input.day
        ? response.results.filter(
            (record) => record.starts_at !== null && record.starts_at?.slice(0, 10) === input.day,
          )
        : response.results;
      const result: Record<string, unknown> = {
        results: matching.slice(0, input.limit).map((record) => compactSession(record, { detail: "list" })),
        pagination: response.pagination,
      };
      if (input.day && response.pagination.totalResults > fetched) {
        result.note = `The day filter was applied to the first ${fetched} of ${response.pagination.totalResults} sessions; refine by track or use the REST API for a complete multi-page result.`;
      }
      return toolJson(result);
    }),
);

const listSubmissions = defineTool(
  {
    name: "list_submissions",
    title: "List submissions",
    description:
      "Search CFP submissions with status, text and track filters. Omit `event_id` to use the event this API key was minted for.",
    inputSchema: z.object({
      event_id: EVENT_ID,
      status: z.array(SESSION_STATUS).min(1).optional().describe("One or more submission statuses."),
      text: z.string().min(1).optional().describe("Text to match in the submission."),
      track: z.string().min(1).optional().describe("Track id or exact name."),
      limit: LIMIT_25,
      page: PAGE,
    }),
    annotations: READ_ANNOTATIONS,
    scope: "read:sessions",
  },
  async (input, { client }) =>
    runTool("read:sessions", client, async () => {
      const id = await eventId(input, client);
      const filters: Record<string, unknown> = { is_abstract: true };
      if (input.status) filters.status = input.status;
      if (input.text) filters.text = input.text;
      if (input.track) filters.track = input.track;
      const response = await client.searchSessions(id, {
        filters,
        sort: { order: "updatedAt", sort: "desc" },
        page: input.page,
        pageSize: input.limit,
      });
      return toolJson({
        results: response.results.map((record) => compactSession(record, { detail: "list" })),
        pagination: response.pagination,
      });
    }),
);

const getSubmission = defineTool(
  {
    name: "get_submission",
    title: "Get submission",
    description:
      "Get one full CFP submission. CFP answers are returned as `custom_fields`; review scores are not exposed on the public API. Omit `event_id` to use the event this API key was minted for.",
    inputSchema: z.object({
      event_id: EVENT_ID,
      submission_id: z.string().min(1).describe("Submission/session id."),
    }),
    annotations: READ_ANNOTATIONS,
    scope: "read:sessions",
  },
  async (input, { client }) =>
    runTool("read:sessions", client, async () => {
      const id = await eventId(input, client);
      return toolJson(compactSession(await client.getSession(id, input.submission_id), { detail: "full" }));
    }),
);

const searchSpeakers = defineTool(
  {
    name: "search_speakers",
    title: "Search speakers",
    description:
      "Search the event's speaker projection by name or contact text. Omit `event_id` to use the event this API key was minted for.",
    inputSchema: z.object({
      event_id: EVENT_ID,
      query: z.string().optional().describe("Optional speaker search text."),
      limit: LIMIT_25,
      page: PAGE,
    }),
    annotations: READ_ANNOTATIONS,
    scope: "read:contacts",
  },
  async (input, { client }) =>
    runTool("read:contacts", client, async () => {
      const id = await eventId(input, client);
      const response = await client.searchSpeakers(id, {
        filters: input.query ? { text: input.query } : {},
        page: input.page,
        pageSize: input.limit,
      });
      return toolJson({
        results: response.results.map(compactSpeaker),
        pagination: response.pagination,
      });
    }),
);

const listTracks = defineTool(
  {
    name: "list_tracks",
    title: "List tracks",
    description:
      "List the event's track ids, names, colours and order. Omit `event_id` to use the event this API key was minted for.",
    inputSchema: z.object({ event_id: EVENT_ID }),
    annotations: READ_ANNOTATIONS,
    scope: "read:metadata",
  },
  async (input, { client }) =>
    runTool("read:metadata", client, async () => {
      const id = await eventId(input, client);
      const response = await client.listMetadata(id, "tracks");
      return toolJson({
        results: response.results.map((track) => ({
          id: track.id ?? null,
          name: track.name ?? null,
          color: typeof track.color === "string" ? track.color : null,
          order: typeof track.order === "number" ? track.order : null,
        })),
        pagination: response.pagination,
      });
    }),
);

const captureAbstract = defineTool(
  {
    name: "capture_abstract",
    title: "Capture abstract",
    description:
      "WRITE a new CFP abstract to the conference. Requires a key with `write:sessions`; the public create endpoint does not attach participants. Omit `event_id` to use the event this API key was minted for.",
    inputSchema: z.object({
      event_id: EVENT_ID,
      title: z.string().trim().min(1).describe("Required abstract title."),
      description: z.string().optional().describe("Abstract description; HTML is accepted by the REST API."),
      track: z.string().min(1).optional().describe("Track id to send as `track_id`."),
      status: SESSION_STATUS.default("pending").describe("Initial submission status."),
      custom_fields: z
        .record(z.string(), z.string())
        .optional()
        .describe("CFP answers keyed by public field key."),
    }),
    annotations: WRITE_ANNOTATIONS,
    scope: "write:sessions",
  },
  async (input, { client }) =>
    runTool("write:sessions", client, async () => {
      const id = await eventId(input, client);
      const body: Record<string, unknown> = {
        title: input.title,
        status: input.status,
        is_abstract: true,
      };
      if (input.description !== undefined) body.description = input.description;
      if (input.track !== undefined) body.track_id = input.track;
      if (input.custom_fields !== undefined) body.custom_fields = input.custom_fields;
      const created = await client.createSession(id, body as { title: string; is_abstract: true });
      return toolJson({
        id: created.id,
        friendly_id: created.friendly_id ?? null,
        title: created.title,
        status: created.status ?? null,
        ...(created.admin_url ? { admin_url: created.admin_url } : {}),
      });
    }),
);

type OpenApiOperation = {
  operationId?: unknown;
  summary?: unknown;
  [key: string]: unknown;
};

function openApiOperations(document: Record<string, unknown>) {
  const rows: Array<{ method: string; path: string; operationId: string | null; summary: string | null; operation: OpenApiOperation }> = [];
  const paths = document.paths;
  if (!paths || typeof paths !== "object" || Array.isArray(paths)) return rows;
  for (const [path, pathItem] of Object.entries(paths as Record<string, unknown>)) {
    if (!pathItem || typeof pathItem !== "object" || Array.isArray(pathItem)) continue;
    for (const [method, operation] of Object.entries(pathItem as Record<string, unknown>)) {
      if (!["get", "post", "put", "delete", "patch"].includes(method)) continue;
      if (!operation || typeof operation !== "object" || Array.isArray(operation)) continue;
      const value = operation as OpenApiOperation;
      rows.push({
        method: method.toUpperCase(),
        path,
        operationId: typeof value.operationId === "string" ? value.operationId : null,
        summary: typeof value.summary === "string" ? value.summary : null,
        operation: value,
      });
    }
  }
  return rows;
}

const getOpenApi = defineTool(
  {
    name: "get_openapi",
    title: "Get OpenAPI",
    description:
      "Read the unauthenticated Callboard REST API description. Omit `section` for a compact operation index, pass an operationId for that operation's schema, or pass `full` for the complete document.",
    inputSchema: z.object({
      section: z.string().optional().describe("An operationId, or `full` for the complete raw document."),
    }),
    annotations: READ_ANNOTATIONS,
    scope: null,
  },
  async (input, { client }) =>
    runTool(null, client, async () => {
      const document = await client.getOpenApi();
      const operations = openApiOperations(document);
      if (input.section === "full") return toolJson(document);
      if (input.section) {
        const match = operations.find((operation) => operation.operationId === input.section);
        if (!match) {
          return errorText(
            `OpenAPI operation '${input.section}' was not found. Call get_openapi without a section to list operationIds.`,
          );
        }
        return toolJson({
          method: match.method,
          path: match.path,
          operationId: match.operationId,
          schema: match.operation,
        });
      }
      const firstServer = Array.isArray(document.servers) ? document.servers[0] : undefined;
      return toolJson({
        openapi: document.openapi ?? null,
        info: document.info ?? null,
        server_url:
          firstServer && typeof firstServer === "object" && typeof firstServer.url === "string"
            ? firstServer.url
            : client.origin,
        operations: operations.map(({ method, path, operationId, summary }) => ({
          method,
          path,
          operationId,
          summary,
        })),
      });
    }),
);

export const CALLBOARD_TOOLS: ToolDefinition[] = [
  listEvents,
  getSchedule,
  listSubmissions,
  getSubmission,
  searchSpeakers,
  listTracks,
  captureAbstract,
  getOpenApi,
];
