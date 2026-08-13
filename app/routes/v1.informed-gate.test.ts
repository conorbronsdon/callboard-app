/**
 * The v1 bypass, closed.
 *
 * Before this lane `parseSessionBody` parsed `is_public` with no create/update
 * mode guard and `updateSession`'s patch loop copied it straight through, so any
 * key with `write:sessions` could publish a session to the public agenda without
 * touching the notification or conflict machinery the admin UI runs.
 *
 * Two rules, each with its own must-not-fire control:
 *   1. `is_public` is accepted ONLY on update — never on create.
 *   2. Flipping it TRUE obeys the same informed-or-override rule as the admin UI.
 */
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { sessionParticipants, sessions } from "~/db/schema";
import { mintApiKey } from "~/lib/api/keys.server";
import { installTestDb, type TestDbContext } from "~/test/db";
import { seedDemoFixture, type DemoFixture } from "~/test/fixtures";

import { action as createAction } from "./v1.sessions.create";
import { action as sessionAction } from "./v1.session";

let ctx: TestDbContext;
let fixture: DemoFixture;
let writeKey: string;

const ORIGIN = "https://callboard.test";

beforeEach(async () => {
  ctx = installTestDb();
  fixture = await seedDemoFixture(ctx.db);
  writeKey = (
    await mintApiKey({
      eventId: fixture.eventId,
      name: "read-write",
      scopes: ["read:events", "read:sessions", "write:sessions", "read:metadata"],
    })
  ).plaintext;
});
afterEach(() => ctx.close());

type Handler = (args: {
  request: Request;
  params: Record<string, string>;
  context: unknown;
}) => Promise<unknown>;

async function call(
  handler: Handler,
  request: Request,
  params: Record<string, string> = {},
): Promise<Response> {
  try {
    const result = await handler({ request, params, context: {} });
    if (result instanceof Response) return result;
    throw new Error(`Handler returned a non-Response: ${JSON.stringify(result)}`);
  } catch (thrown) {
    if (thrown instanceof Response) return thrown;
    throw thrown;
  }
}

function request(method: string, path: string, options: { key?: string; body?: unknown } = {}) {
  const headers: Record<string, string> = {};
  if (options.key) headers["x-access-token"] = options.key;
  if (options.body !== undefined) headers["content-type"] = "application/json";
  return new Request(`${ORIGIN}${path}`, {
    method,
    headers,
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function json(response: Response): Promise<Record<string, any>> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (await response.json()) as Record<string, any>;
}

const eventPath = (suffix = "") => `/v1/event/${fixture.eventId}${suffix}`;

let counter = 0;

/** A scheduled, unpublished programme session composed from an abstract. */
async function addProgrammeSession(informed: boolean): Promise<string> {
  counter += 1;
  const id = `v1gate-sess-${counter}`;
  await ctx.db.insert(sessions).values({
    id,
    eventId: fixture.eventId,
    friendlyId: `V1GATE-${counter}`,
    title: `Gate probe ${counter}`,
    status: "accepted",
    isAbstract: false,
    startsAt: new Date(Date.now() + 86_400_000),
    endsAt: new Date(Date.now() + 86_400_000 + 1_800_000),
    isPublic: false,
    speakerInformedAt: informed ? new Date() : null,
  });
  await ctx.db.insert(sessionParticipants).values({
    sessionId: id,
    personId: fixture.speakerIds[0],
    role: "speaker",
    isPrimary: true,
    order: 0,
  });
  const abstractId = `v1gate-abs-${counter}`;
  await ctx.db.insert(sessions).values({
    id: abstractId,
    eventId: fixture.eventId,
    friendlyId: `V1GATE-ABS-${counter}`,
    title: `Gate probe ${counter}`,
    status: "accepted",
    isAbstract: true,
    composedIntoSessionId: id,
  });
  return id;
}

const rowFor = async (id: string) =>
  ctx.db.query.sessions.findFirst({ where: eq(sessions.id, id) });

describe("v1: is_public is not a create-time field", () => {
  it("MUST FIRE: POST /sessions with is_public is rejected, and nothing is created public", async () => {
    const response = await call(
      createAction as Handler,
      request("POST", eventPath("/sessions"), {
        key: writeKey,
        body: { title: "Backdoor publish", is_public: true },
      }),
      { eventId: fixture.eventId },
    );

    expect(response.status).toBe(400);
    const body = await json(response);
    expect(body.error).toBe("ValidationError");
    expect(body.message).toContain("is_public");

    // Assert the VALUE, not just the status: no public row appeared.
    const created = await ctx.db
      .select()
      .from(sessions)
      .where(eq(sessions.title, "Backdoor publish"));
    expect(created).toHaveLength(0);
  });

  it("MUST NOT FIRE: a create without is_public still works and lands unpublished", async () => {
    const response = await call(
      createAction as Handler,
      request("POST", eventPath("/sessions"), {
        key: writeKey,
        body: { title: "Ordinary create" },
      }),
      { eventId: fixture.eventId },
    );

    expect(response.status).toBe(201);
    const body = await json(response);
    expect(body.is_public).toBe(false);
  });
});

describe("v1: flipping is_public true obeys the informed gate", () => {
  it("MUST FIRE: PUT is_public=true on an uninformed session is refused and the row does not move", async () => {
    const id = await addProgrammeSession(false);

    const response = await call(
      sessionAction as Handler,
      request("PUT", eventPath(`/sessions/${id}`), {
        key: writeKey,
        body: { is_public: true },
      }),
      { eventId: fixture.eventId, sessionId: id },
    );

    expect(response.status).toBe(409);
    const body = await json(response);
    expect(body.error).toBe("ConflictError");
    expect(body.message).toContain("hasn't been told");

    const row = await rowFor(id);
    expect(row?.isPublic).toBe(false);
    expect(row?.publishedAt).toBeNull();
  });

  it("MUST NOT FIRE: PUT is_public=true on an INFORMED session publishes as before", async () => {
    const id = await addProgrammeSession(true);

    const response = await call(
      sessionAction as Handler,
      request("PUT", eventPath(`/sessions/${id}`), {
        key: writeKey,
        body: { is_public: true },
      }),
      { eventId: fixture.eventId, sessionId: id },
    );

    expect(response.status).toBe(200);
    expect((await rowFor(id))?.isPublic).toBe(true);
  });

  it("MUST NOT FIRE: an explicit publish_override publishes an uninformed session", async () => {
    const id = await addProgrammeSession(false);

    const response = await call(
      sessionAction as Handler,
      request("PUT", eventPath(`/sessions/${id}`), {
        key: writeKey,
        body: { is_public: true, publish_override: true },
      }),
      { eventId: fixture.eventId, sessionId: id },
    );

    expect(response.status).toBe(200);
    expect((await rowFor(id))?.isPublic).toBe(true);
  });

  it("MUST NOT FIRE: the gate never blocks UNpublishing through v1", async () => {
    const id = await addProgrammeSession(false);
    await ctx.db
      .update(sessions)
      .set({ isPublic: true, publishedAt: new Date() })
      .where(eq(sessions.id, id));

    const response = await call(
      sessionAction as Handler,
      request("PUT", eventPath(`/sessions/${id}`), {
        key: writeKey,
        body: { is_public: false },
      }),
      { eventId: fixture.eventId, sessionId: id },
    );

    expect(response.status).toBe(200);
    expect((await rowFor(id))?.isPublic).toBe(false);
  });

  it("MUST NOT FIRE: publish_override is a control flag, never a stored column", async () => {
    const id = await addProgrammeSession(false);
    await call(
      sessionAction as Handler,
      request("PUT", eventPath(`/sessions/${id}`), {
        key: writeKey,
        body: { is_public: true, publish_override: true },
      }),
      { eventId: fixture.eventId, sessionId: id },
    );

    // The patch loop must not have tried to write it onto the row.
    const raw = ctx.sqlite
      .prepare("SELECT * FROM sessions WHERE id = ?")
      .get(id) as Record<string, unknown>;
    expect(Object.keys(raw)).not.toContain("publish_override");
    expect((raw as { is_public: number }).is_public).toBe(1);
  });
});
