/**
 * These tests pin the public wire contract, not just handler return shapes.
 * Every scoped tool proves its URL/method/body on success, refuses missing auth
 * without fetching, and turns a v1 scope refusal into a recoverable MCP error.
 */
import { describe, expect, it } from "vitest";

import { CallboardClient } from "./client";
import { compactSession, stripHtml, truncate } from "./format";
import { CALLBOARD_TOOLS, type ToolResult } from "./tools";

const ORIGIN = "https://callboard.test";
const API_KEY = "cb_live_secret_sentinel_987654";
const PAGINATION = { currentPage: 1, pageSize: 25, totalPages: 1, totalResults: 1 };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

class FetchQueue {
  readonly requests: Request[] = [];
  private readonly responses: Response[];

  constructor(...responses: Response[]) {
    this.responses = responses;
  }

  readonly fetch: typeof fetch = async (input, init) => {
    this.requests.push(new Request(input, init));
    const response = this.responses.shift();
    if (!response) throw new Error("Unexpected HTTP request");
    return response;
  };
}

function client(mock: FetchQueue, apiKey: string | null = API_KEY): CallboardClient {
  return new CallboardClient({ origin: ORIGIN, apiKey, fetchImpl: mock.fetch });
}

function tool(name: string) {
  const definition = CALLBOARD_TOOLS.find((candidate) => candidate.name === name);
  if (!definition) throw new Error(`Missing tool ${name}`);
  return definition;
}

async function call(
  name: string,
  input: Record<string, unknown>,
  callboardClient: CallboardClient,
): Promise<ToolResult> {
  return tool(name).handler(input, { client: callboardClient });
}

function value(result: ToolResult): any {
  return JSON.parse(result.content[0].text);
}

async function bodyOf(request: Request): Promise<any> {
  return request.clone().json();
}

function session(overrides: Record<string, unknown> = {}) {
  return {
    id: "session-1",
    event_id: "event-1",
    friendly_id: "ABS-7",
    title: "Shipping dependable agents",
    description: "<p>Useful &amp; concrete.</p>",
    status: "pending",
    is_abstract: true,
    starts_at: null,
    ends_at: null,
    capacity: 80,
    is_public: false,
    composition_status: { role: "standalone" },
    track: { id: "track-uuid", name: "Agents", color: "#123456" },
    room: { id: "room-uuid", name: "Main Hall" },
    participants: [
      {
        id: "person-uuid",
        full_name: "Rina Okafor",
        email: "rina@example.com",
        company_name: "Practical AI",
      },
    ],
    custom_fields: [{ key: "takeaways", value: "Three production checks" }],
    created_at: "2026-08-01T10:00:00.000Z",
    updated_at: "2026-08-02T10:00:00.000Z",
    deleted_at: null,
    admin_url: `${ORIGIN}/admin/submissions/session-1`,
    ...overrides,
  };
}

describe("happy-path wire contracts", () => {
  it("list_events calls GET /v1/events and returns selected event values", async () => {
    const mock = new FetchQueue(
      json({
        results: [{ id: "event-1", name: "Frontier AI", slug: "frontier-ai", timezone: "America/Los_Angeles", admin_url: "discard" }],
        pagination: PAGINATION,
      }),
    );
    const result = await call("list_events", {}, client(mock));

    expect(mock.requests).toHaveLength(1);
    expect(mock.requests[0].url).toBe(`${ORIGIN}/v1/events`);
    expect(mock.requests[0].method).toBe("GET");
    expect(mock.requests[0].headers.get("x-access-token")).toBe(API_KEY);
    expect(value(result)).toEqual({
      results: [{ id: "event-1", name: "Frontier AI", slug: "frontier-ai", timezone: "America/Los_Angeles" }],
      pagination: PAGINATION,
    });
  });

  it("get_schedule posts the programme filter and compacts nested records", async () => {
    const scheduled = session({
      id: "programme-1",
      friendly_id: "SESS-2",
      is_abstract: false,
      starts_at: "2026-09-14T09:00:00.000Z",
    });
    const mock = new FetchQueue(json({ results: [scheduled], pagination: PAGINATION }));
    const result = await call(
      "get_schedule",
      { event_id: "event-1", track: "Agents", limit: 10 },
      client(mock),
    );

    expect(mock.requests[0].url).toBe(`${ORIGIN}/v1/event/event-1/sessions/search`);
    expect(mock.requests[0].method).toBe("POST");
    expect(await bodyOf(mock.requests[0])).toEqual({
      filters: { is_abstract: false, track: "Agents" },
      sort: { order: "startsAt", sort: "asc" },
      page: 1,
      pageSize: 100,
    });
    expect(value(result).results[0]).toMatchObject({
      id: "programme-1",
      title: "Shipping dependable agents",
      schedule_state: "scheduled",
      track: "Agents",
      room: "Main Hall",
      participants: [{ name: "Rina Okafor", email: "rina@example.com", company: "Practical AI" }],
    });
    expect(value(result).results[0]).not.toHaveProperty("custom_fields");
  });

  it("list_submissions sends validated filters, paging and compact list output", async () => {
    const mock = new FetchQueue(json({ results: [session()], pagination: PAGINATION }));
    const result = await call(
      "list_submissions",
      { event_id: "event-1", status: ["pending"], text: "agents", track: "Agents", limit: 12, page: 2 },
      client(mock),
    );

    expect(mock.requests[0].url).toBe(`${ORIGIN}/v1/event/event-1/sessions/search`);
    expect(mock.requests[0].method).toBe("POST");
    expect(await bodyOf(mock.requests[0])).toEqual({
      filters: { is_abstract: true, status: ["pending"], text: "agents", track: "Agents" },
      sort: { order: "updatedAt", sort: "desc" },
      page: 2,
      pageSize: 12,
    });
    expect(value(result).results[0].description).toEqual({
      text: "Useful & concrete.",
      truncated: false,
      originalLength: 18,
    });
    expect(value(result).pagination.totalResults).toBe(1);
  });

  it("get_submission calls the record URL and preserves CFP answers in full mode", async () => {
    const mock = new FetchQueue(json(session()));
    const result = await call(
      "get_submission",
      { event_id: "event-1", submission_id: "session-1" },
      client(mock),
    );

    expect(mock.requests[0].url).toBe(`${ORIGIN}/v1/event/event-1/sessions/session-1`);
    expect(mock.requests[0].method).toBe("GET");
    expect(value(result)).toMatchObject({
      id: "session-1",
      custom_fields: [{ key: "takeaways", value: "Three production checks" }],
      capacity: 80,
      admin_url: `${ORIGIN}/admin/submissions/session-1`,
    });
  });

  it("search_speakers posts text filters and returns compact speaker values", async () => {
    const mock = new FetchQueue(
      json({
        results: [{ id: "speaker-1", full_name: "Rina Okafor", company_name: "Practical AI", email: "rina@example.com", about: "<p>Builds &amp; tests agents.</p>", photo_url: "discard" }],
        pagination: PAGINATION,
      }),
    );
    const result = await call(
      "search_speakers",
      { event_id: "event-1", query: "Rina", limit: 8, page: 3 },
      client(mock),
    );

    expect(mock.requests[0].url).toBe(`${ORIGIN}/v1/event/event-1/speakers/search`);
    expect(mock.requests[0].method).toBe("POST");
    expect(await bodyOf(mock.requests[0])).toEqual({ filters: { text: "Rina" }, page: 3, pageSize: 8 });
    expect(value(result).results[0]).toEqual({
      id: "speaker-1",
      name: "Rina Okafor",
      company: "Practical AI",
      email: "rina@example.com",
      about: { text: "Builds & tests agents.", truncated: false, originalLength: 22 },
    });
  });

  it("list_tracks calls the tracks family and drops event-level metadata noise", async () => {
    const mock = new FetchQueue(
      json({
        results: [{ id: "track-1", event_id: "event-1", name: "Agents", color: "#123456", order: 2, created_at: "discard" }],
        pagination: PAGINATION,
      }),
    );
    const result = await call("list_tracks", { event_id: "event-1" }, client(mock));

    expect(mock.requests[0].url).toBe(`${ORIGIN}/v1/event/event-1/tracks`);
    expect(mock.requests[0].method).toBe("GET");
    expect(value(result)).toEqual({
      results: [{ id: "track-1", name: "Agents", color: "#123456", order: 2 }],
      pagination: PAGINATION,
    });
  });

  it("capture_abstract posts only the verified create contract and returns identifiers", async () => {
    const mock = new FetchQueue(json(session({ id: "created-1", friendly_id: "ABS-8", title: "New abstract", status: "pending" })));
    const result = await call(
      "capture_abstract",
      {
        event_id: "event-1",
        title: "New abstract",
        description: "A useful proposal",
        track: "track-1",
        custom_fields: { takeaways: "Three checks" },
      },
      client(mock),
    );

    expect(mock.requests[0].url).toBe(`${ORIGIN}/v1/event/event-1/sessions/create`);
    expect(mock.requests[0].method).toBe("POST");
    expect(await bodyOf(mock.requests[0])).toEqual({
      title: "New abstract",
      status: "pending",
      is_abstract: true,
      description: "A useful proposal",
      track_id: "track-1",
      custom_fields: { takeaways: "Three checks" },
    });
    expect(value(result)).toEqual({
      id: "created-1",
      friendly_id: "ABS-8",
      title: "New abstract",
      status: "pending",
      admin_url: `${ORIGIN}/admin/submissions/session-1`,
    });
  });

  it("get_openapi calls the unauthenticated document and returns a compact index", async () => {
    const document = {
      openapi: "3.1.0",
      info: { title: "Callboard API", version: "1.0.0" },
      servers: [{ url: ORIGIN }],
      paths: {
        "/v1/events": {
          get: { operationId: "listEvents", summary: "List events", responses: { 200: { description: "OK" } } },
        },
      },
      components: { schemas: { Huge: { description: "x".repeat(2_000) } } },
    };
    const mock = new FetchQueue(json(document));
    const result = await call("get_openapi", {}, client(mock, null));

    expect(mock.requests[0].url).toBe(`${ORIGIN}/v1/openapi.json`);
    expect(mock.requests[0].method).toBe("GET");
    expect(mock.requests[0].headers.has("x-access-token")).toBe(false);
    expect(value(result)).toEqual({
      openapi: "3.1.0",
      info: { title: "Callboard API", version: "1.0.0" },
      server_url: ORIGIN,
      operations: [{ method: "GET", path: "/v1/events", operationId: "listEvents", summary: "List events" }],
    });
  });
});

const scopedCases = [
  ["list_events", {}, "read:events"],
  ["get_schedule", { event_id: "event-1" }, "read:sessions"],
  ["list_submissions", { event_id: "event-1" }, "read:sessions"],
  ["get_submission", { event_id: "event-1", submission_id: "session-1" }, "read:sessions"],
  ["search_speakers", { event_id: "event-1" }, "read:contacts"],
  ["list_tracks", { event_id: "event-1" }, "read:metadata"],
  ["capture_abstract", { event_id: "event-1", title: "Proposal" }, "write:sessions"],
] as const;

describe("missing authentication", () => {
  for (const [name, input, scope] of scopedCases) {
    it(`${name} names its header and scope without issuing HTTP`, async () => {
      const mock = new FetchQueue();
      const result = await call(name, input, client(mock, null));

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("x-access-token");
      expect(result.content[0].text).toContain(scope);
      expect(mock.requests).toHaveLength(0);
    });
  }
});

describe("scope refusal", () => {
  for (const [name, input, scope] of scopedCases) {
    it(`${name} turns 403 into a ${scope} recovery message`, async () => {
      const mock = new FetchQueue(
        json({ error: "ForbiddenError", message: "This key lacks scope." }, 403),
      );
      const result = await call(name, input, client(mock));

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain(scope);
      expect(result.content[0].text).toContain("/admin/api-keys");
      expect(mock.requests).toHaveLength(1);
    });
  }
});

describe("context-window and resolution edge cases", () => {
  it("get_openapi is not auth-gated and its index is materially smaller than full", async () => {
    const document = {
      openapi: "3.1.0",
      info: { title: "Callboard", version: "1" },
      paths: {
        "/v1/events": { get: { operationId: "listEvents", summary: "List", description: "x".repeat(1_000) } },
      },
      components: { schemas: { Session: { description: "y".repeat(10_000) } } },
    };
    const mock = new FetchQueue(json(document), json(document));
    const callboardClient = client(mock, null);
    const index = await call("get_openapi", {}, callboardClient);
    const full = await call("get_openapi", { section: "full" }, callboardClient);

    expect(index.isError).not.toBe(true);
    expect(full.isError).not.toBe(true);
    expect(new TextEncoder().encode(index.content[0].text).byteLength).toBeLessThan(
      new TextEncoder().encode(full.content[0].text).byteLength / 5,
    );
    expect(mock.requests).toHaveLength(2);
  });

  it("get_openapi returns one operation fragment by operationId", async () => {
    const document = {
      openapi: "3.1.0",
      paths: {
        "/v1/events": {
          get: {
            operationId: "listEvents",
            summary: "List events",
            responses: { "200": { description: "One event" } },
          },
        },
      },
    };
    const mock = new FetchQueue(json(document));
    const result = await call("get_openapi", { section: "listEvents" }, client(mock, null));

    expect(value(result)).toEqual({
      method: "GET",
      path: "/v1/events",
      operationId: "listEvents",
      schema: {
        operationId: "listEvents",
        summary: "List events",
        responses: { "200": { description: "One event" } },
      },
    });
  });

  it("resolves an omitted event id once across two tool calls on one client", async () => {
    const mock = new FetchQueue(
      json({ results: [{ id: "event-memo", name: "Memo Event" }], pagination: PAGINATION }),
      json({ results: [], pagination: { ...PAGINATION, totalResults: 0 } }),
      json({ results: [], pagination: { ...PAGINATION, totalResults: 0 } }),
    );
    const callboardClient = client(mock);
    await call("get_schedule", {}, callboardClient);
    await call("list_submissions", {}, callboardClient);

    expect(mock.requests.map((request) => new URL(request.url).pathname)).toEqual([
      "/v1/events",
      "/v1/event/event-memo/sessions/search",
      "/v1/event/event-memo/sessions/search",
    ]);
  });

  it("strips common HTML entities and truncates at the exact boundary with a visible marker", () => {
    expect(stripHtml("<p>A &amp; B&nbsp;&lt;x&gt; &quot;q&quot; &#39;s&#39;</p>")).toBe(
      `A & B <x> "q" 's'`,
    );
    expect(truncate("12345", 5)).toEqual({ text: "12345", truncated: false, originalLength: 5 });

    const long = "a".repeat(2_431);
    const result = truncate(long, 200);
    expect(result.truncated).toBe(true);
    expect(result.originalLength).toBe(2_431);
    expect(result.text.length).toBeLessThanOrEqual(200);
    expect(result.text).toMatch(/… \[truncated: 2,431 chars total — call get_submission for the full text\]$/);
  });

  it("get_schedule day filtering excludes other days and null starts, and warns on a partial page", async () => {
    const mock = new FetchQueue(
      json({
        results: [
          session({ id: "same-day", is_abstract: false, starts_at: "2026-09-14T09:00:00Z" }),
          session({ id: "other-day", is_abstract: false, starts_at: "2026-09-15T09:00:00Z" }),
          session({ id: "unscheduled", is_abstract: false, starts_at: null }),
        ],
        pagination: { currentPage: 1, pageSize: 100, totalPages: 2, totalResults: 130 },
      }),
    );
    const result = await call(
      "get_schedule",
      { event_id: "event-1", day: "2026-09-14" },
      client(mock),
    );
    const parsed = value(result);

    expect(parsed.results.map((record: { id: string }) => record.id)).toEqual(["same-day"]);
    expect(parsed.note).toBe(
      "The day filter was applied to the first 3 of 130 sessions; refine by track or use the REST API for a complete multi-page result.",
    );
  });

  it("marks null-start sessions unscheduled when no day filter is present", () => {
    expect(compactSession(session(), { detail: "list" }).schedule_state).toBe("unscheduled");
  });

  it("never echoes a key-shaped sentinel from an upstream error", async () => {
    const mock = new FetchQueue(
      json({ error: "ForbiddenError", message: `Rejected ${API_KEY}` }, 403),
    );
    const result = await call("list_tracks", { event_id: "event-1" }, client(mock));

    expect(JSON.stringify(result)).not.toContain(API_KEY);
    expect(result.isError).toBe(true);
  });

  it("tells callers how to recover when event inference lacks read:events", async () => {
    const mock = new FetchQueue(json({ error: "ForbiddenError", message: "No scope" }, 403));
    const result = await call("get_schedule", {}, client(mock));

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Pass `event_id` explicitly");
    expect(result.content[0].text).toContain("read:events");
  });

  it("rejects an invalid submission status at the zod boundary before HTTP", async () => {
    const mock = new FetchQueue();
    await expect(
      call("list_submissions", { event_id: "event-1", status: ["maybe"] }, client(mock)),
    ).rejects.toThrow();
    expect(mock.requests).toHaveLength(0);
  });
});
