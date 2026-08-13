/**
 * The MCP worker is an ordinary `/v1` consumer, not a privileged product
 * process. Keeping this client free of bindings and database imports prevents
 * the integration from quietly gaining access that a third-party API key does
 * not have. Its injected fetch also makes every wire detail testable.
 */

export interface CallboardClientOptions {
  origin: string;
  apiKey: string | null;
  fetchImpl?: typeof fetch;
}

export interface Pagination {
  currentPage: number;
  pageSize: number;
  totalPages: number;
  totalResults: number;
}

export interface Collection<T> {
  results: T[];
  pagination: Pagination;
}

export interface EventRecord extends Record<string, unknown> {
  id: string;
  name: string;
  slug?: string;
  timezone?: string;
}

export interface NamedRecord extends Record<string, unknown> {
  id?: string;
  name?: string | null;
}

export interface ParticipantRecord extends Record<string, unknown> {
  full_name?: string | null;
  name?: string | null;
  email?: string | null;
  company_name?: string | null;
  company?: string | null;
}

export interface SessionRecord extends Record<string, unknown> {
  id: string;
  event_id?: string;
  friendly_id?: string | null;
  title: string;
  description?: string | null;
  status?: string;
  is_abstract?: boolean;
  starts_at?: string | null;
  ends_at?: string | null;
  capacity?: number | null;
  is_public?: boolean;
  composition_status?: unknown;
  track?: NamedRecord | null;
  room?: NamedRecord | null;
  format?: NamedRecord | null;
  level?: NamedRecord | null;
  tags?: NamedRecord[];
  participants?: ParticipantRecord[];
  custom_fields?: Array<{ key: string; value: unknown }>;
  created_at?: string | null;
  updated_at?: string | null;
  deleted_at?: string | null;
  admin_url?: string;
}

export interface SpeakerRecord extends Record<string, unknown> {
  id: string;
  full_name?: string | null;
  name?: string | null;
  email?: string | null;
  company_name?: string | null;
  company?: string | null;
  about?: string | null;
  session_ids?: string[];
}

export type MetadataFamily = "tracks" | "rooms" | "tags" | "formats" | "levels";

export interface SessionSearchRequest {
  filters?: Record<string, unknown>;
  sort?: { order: "createdAt" | "updatedAt" | "startsAt" | "title"; sort: "asc" | "desc" };
  page?: number;
  pageSize?: number;
}

export interface SpeakerSearchRequest {
  filters?: { text?: string };
  page?: number;
  pageSize?: number;
}

export interface SessionCreateRequest extends Record<string, unknown> {
  title: string;
  is_abstract?: boolean;
}

interface ApiErrorBody {
  error?: unknown;
  message?: unknown;
}

export class CallboardApiError extends Error {
  readonly status: number;
  readonly error: string;

  constructor(details: { status: number; error: string; message: string }) {
    super(details.message);
    this.name = "CallboardApiError";
    this.status = details.status;
    this.error = details.error;
  }
}

export class CallboardUnauthorizedError extends CallboardApiError {
  constructor(details: { status: number; error: string; message: string }) {
    super(details);
    this.name = "CallboardUnauthorizedError";
  }
}

export class CallboardForbiddenError extends CallboardApiError {
  constructor(details: { status: number; error: string; message: string }) {
    super(details);
    this.name = "CallboardForbiddenError";
  }
}

export class CallboardEventResolutionError extends CallboardForbiddenError {
  constructor() {
    super({
      status: 403,
      error: "ForbiddenError",
      message:
        "Callboard could not infer the event because this key cannot list events. Pass `event_id` explicitly or mint a key with the `read:events` scope.",
    });
    this.name = "CallboardEventResolutionError";
  }
}

export class CallboardClient {
  readonly origin: string;
  readonly apiKey: string | null;
  private readonly fetchImpl: typeof fetch;
  private eventIdPromise: Promise<string> | undefined;

  constructor(options: CallboardClientOptions) {
    this.origin = options.origin.replace(/\/$/, "");
    this.apiKey = options.apiKey;
    /*
     * `?? fetch` — without the bind — is the version that shipped first, and it
     * threw "Illegal invocation: function called with incorrect `this`
     * reference" on every single tool call in the deployed Worker. workerd
     * requires the global fetch to keep its `globalThis` receiver; detaching it
     * into a field drops that receiver. Node's fetch tolerates the same code,
     * which is exactly why the unit suite never saw it: every test injects
     * `fetchImpl`, so the default branch is only ever exercised on workerd.
     */
    this.fetchImpl = options.fetchImpl ?? fetch.bind(globalThis);
  }

  listEvents(): Promise<Collection<EventRecord>> {
    return this.request("/v1/events");
  }

  searchSessions(eventId: string, body: SessionSearchRequest): Promise<Collection<SessionRecord>> {
    return this.request(`/v1/event/${encodeURIComponent(eventId)}/sessions/search`, {
      method: "POST",
      body: JSON.stringify(body),
    });
  }

  getSession(eventId: string, sessionId: string): Promise<SessionRecord> {
    return this.request(
      `/v1/event/${encodeURIComponent(eventId)}/sessions/${encodeURIComponent(sessionId)}`,
    );
  }

  createSession(eventId: string, body: SessionCreateRequest): Promise<SessionRecord> {
    return this.request(`/v1/event/${encodeURIComponent(eventId)}/sessions/create`, {
      method: "POST",
      body: JSON.stringify(body),
    });
  }

  searchSpeakers(eventId: string, body: SpeakerSearchRequest): Promise<Collection<SpeakerRecord>> {
    return this.request(`/v1/event/${encodeURIComponent(eventId)}/speakers/search`, {
      method: "POST",
      body: JSON.stringify(body),
    });
  }

  getSpeaker(eventId: string, contactId: string): Promise<SpeakerRecord> {
    return this.request(
      `/v1/event/${encodeURIComponent(eventId)}/speakers/${encodeURIComponent(contactId)}`,
    );
  }

  listMetadata(eventId: string, family: MetadataFamily): Promise<Collection<NamedRecord>> {
    return this.request(`/v1/event/${encodeURIComponent(eventId)}/${family}`);
  }

  getOpenApi(): Promise<Record<string, unknown>> {
    return this.request("/v1/openapi.json");
  }

  resolveEventId(): Promise<string> {
    this.eventIdPromise ??= this.fetchEventId();
    return this.eventIdPromise;
  }

  private async fetchEventId(): Promise<string> {
    let events: Collection<EventRecord>;
    try {
      events = await this.listEvents();
    } catch (error) {
      if (error instanceof CallboardForbiddenError) {
        throw new CallboardEventResolutionError();
      }
      throw error;
    }
    const id = events.results[0]?.id;
    if (!id) {
      throw new CallboardApiError({
        status: 502,
        error: "InvalidUpstreamResponse",
        message: "Callboard returned no event for this event-scoped API key.",
      });
    }
    return id;
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const headers = new Headers(init.headers);
    headers.set("accept", "application/json");
    if (init.body !== undefined) headers.set("content-type", "application/json");
    if (this.apiKey !== null) headers.set("x-access-token", this.apiKey);

    const response = await this.fetchImpl(`${this.origin}${path}`, { ...init, headers });
    const body = await response.text();
    if (!response.ok) throw parseApiError(response.status, body);

    try {
      return JSON.parse(body) as T;
    } catch {
      throw new CallboardApiError({
        status: response.status,
        error: "InvalidUpstreamResponse",
        message: "Callboard returned a non-JSON success response.",
      });
    }
  }
}

function parseApiError(status: number, body: string): CallboardApiError {
  let parsed: ApiErrorBody = {};
  try {
    parsed = JSON.parse(body) as ApiErrorBody;
  } catch {
    // A proxy-generated HTML/text error is still represented as a typed error.
  }
  /*
   * A non-JSON body means the response came from something in front of the
   * application — an edge error page, a proxy — and the status alone does not
   * say which. Carrying a bounded snippet turns "HTTP 503" into a sentence a
   * caller can act on, and the body of an error page holds no credential.
   */
  const snippet =
    typeof parsed.message === "string"
      ? null
      : body.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 200);
  const details = {
    status,
    error: typeof parsed.error === "string" ? parsed.error : "CallboardApiError",
    message:
      typeof parsed.message === "string"
        ? parsed.message
        : `Callboard API request failed with HTTP ${status}.${snippet ? ` Upstream said: ${snippet}` : ""}`,
  };
  if (status === 401) return new CallboardUnauthorizedError(details);
  if (status === 403) return new CallboardForbiddenError(details);
  return new CallboardApiError(details);
}
