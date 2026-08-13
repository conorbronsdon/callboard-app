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

import {
  gateOverrides,
  sessionParticipants,
  sessions,
  webhookDeliveries,
  webhooks,
} from "~/db/schema";
import { mintApiKey } from "~/lib/api/keys.server";
import { installTestDb, type TestDbContext } from "~/test/db";
import { seedDemoFixture, type DemoFixture } from "~/test/fixtures";

import { action as createAction } from "./v1.sessions.create";
import { action as bulkAction } from "./v1.sessions.bulk";
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

interface ProgrammeSessionOptions {
  startsAt?: Date | null;
  endsAt?: Date | null;
  personId?: string;
  roomId?: string | null;
  trackId?: string | null;
  isPublic?: boolean;
}

/** A programme session composed from an abstract. */
async function addProgrammeSession(
  informed: boolean,
  options: ProgrammeSessionOptions = {},
): Promise<string> {
  counter += 1;
  const id = `v1gate-sess-${counter}`;
  const defaultStart = new Date(Date.UTC(2032, 0, 1, counter * 2));
  await ctx.db.insert(sessions).values({
    id,
    eventId: fixture.eventId,
    friendlyId: `V1GATE-${counter}`,
    title: `Gate probe ${counter}`,
    status: "accepted",
    isAbstract: false,
    startsAt: options.startsAt === undefined ? defaultStart : options.startsAt,
    endsAt:
      options.endsAt === undefined
        ? new Date(defaultStart.getTime() + 1_800_000)
        : options.endsAt,
    roomId: options.roomId ?? null,
    trackId: options.trackId ?? null,
    isPublic: options.isPublic ?? false,
    speakerInformedAt: informed ? new Date() : null,
  });
  await ctx.db.insert(sessionParticipants).values({
    sessionId: id,
    personId: options.personId ?? fixture.speakerIds[0],
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

  it("MUST FIRE: publish_force is update-only", async () => {
    const response = await call(
      createAction as Handler,
      request("POST", eventPath("/sessions"), {
        key: writeKey,
        body: { title: "Control fields stay on updates", publish_force: true },
      }),
      { eventId: fixture.eventId },
    );

    expect(response.status).toBe(400);
    expect((await json(response)).message).toContain("publish_force");
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
        body: {
          is_public: true,
          publish_override: true,
          publish_override_reason: "Speaker confirmed by phone.",
        },
      }),
      { eventId: fixture.eventId, sessionId: id },
    );

    expect(response.status).toBe(200);
    expect((await rowFor(id))?.isPublic).toBe(true);
    expect(await ctx.db.select().from(gateOverrides)).toMatchObject([
      {
        kind: "publish_override",
        reason: "Speaker confirmed by phone.",
        sessionId: id,
        overriddenByName: 'API key "read-write"',
      },
    ]);
  });

  it("MUST FIRE: publish_override without its reason is rejected before the write", async () => {
    const id = await addProgrammeSession(false);
    const response = await call(
      sessionAction as Handler,
      request("PUT", eventPath(`/sessions/${id}`), {
        key: writeKey,
        body: { is_public: true, publish_override: true },
      }),
      { eventId: fixture.eventId, sessionId: id },
    );

    expect(response.status).toBe(400);
    expect((await json(response)).message).toContain("publish_override_reason");
    expect((await rowFor(id))?.isPublic).toBe(false);
    expect(await ctx.db.select().from(gateOverrides)).toEqual([]);
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
        body: {
          is_public: true,
          publish_override: true,
          publish_override_reason: "Speaker confirmed by phone.",
        },
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

describe("v1: publishing obeys the blocking-conflict gate (DECISIONS #70)", () => {
  const overlapStart = new Date("2033-05-01T16:00:00.000Z");
  const overlapEnd = new Date("2033-05-01T17:00:00.000Z");

  async function addSpeakerClash() {
    const first = await addProgrammeSession(true, {
      startsAt: overlapStart,
      endsAt: overlapEnd,
      roomId: fixture.roomIds[0],
    });
    const second = await addProgrammeSession(true, {
      startsAt: overlapStart,
      endsAt: overlapEnd,
      roomId: fixture.roomIds[1],
    });
    return { first, second };
  }

  it("MUST FIRE: a speaker double-booking refuses publication and leaves the row private", async () => {
    const { first } = await addSpeakerClash();

    const response = await call(
      sessionAction as Handler,
      request("PUT", eventPath(`/sessions/${first}`), {
        key: writeKey,
        body: { is_public: true },
      }),
      { eventId: fixture.eventId, sessionId: first },
    );

    expect(response.status).toBe(409);
    const body = await json(response);
    expect(body.error).toBe("ConflictError");
    expect(body.message).toContain("Speaker double-booked");
    expect((await rowFor(first))?.isPublic).toBe(false);
  });

  it("MUST FIRE: publication predicts conflicts from the placement in the same update", async () => {
    const moving = await addProgrammeSession(true, {
      roomId: fixture.roomIds[0],
    });
    await addProgrammeSession(true, {
      startsAt: overlapStart,
      endsAt: overlapEnd,
      roomId: fixture.roomIds[1],
    });

    const response = await call(
      sessionAction as Handler,
      request("PUT", eventPath(`/sessions/${moving}`), {
        key: writeKey,
        body: {
          is_public: true,
          starts_at: overlapStart.toISOString(),
          ends_at: overlapEnd.toISOString(),
        },
      }),
      { eventId: fixture.eventId, sessionId: moving },
    );

    expect(response.status).toBe(409);
    expect((await json(response)).message).toContain("Speaker double-booked");
    expect((await rowFor(moving))?.isPublic).toBe(false);
  });

  it("MUST NOT FIRE: publish_force allows the double-booked session to publish", async () => {
    const { first } = await addSpeakerClash();

    const response = await call(
      sessionAction as Handler,
      request("PUT", eventPath(`/sessions/${first}`), {
        key: writeKey,
        body: {
          is_public: true,
          publish_force: true,
          publish_force_reason: "Speaker accepted the clash.",
        },
      }),
      { eventId: fixture.eventId, sessionId: first },
    );

    expect(response.status).toBe(200);
    expect((await rowFor(first))?.isPublic).toBe(true);
    expect(await ctx.db.select().from(gateOverrides)).toMatchObject([
      {
        kind: "publish_force",
        reason: "Speaker accepted the clash.",
        sessionId: first,
        overriddenByName: 'API key "read-write"',
      },
    ]);
  });

  it("MUST FIRE: publish_force without a reason refuses before write or webhook emission", async () => {
    const { first } = await addSpeakerClash();
    await ctx.db.insert(webhooks).values({
      id: "reason-gate-endpoint",
      url: "https://receiver.test/hooks/callboard",
      secret: "reason-gate-secret",
    });

    const response = await call(
      sessionAction as Handler,
      request("PUT", eventPath(`/sessions/${first}`), {
        key: writeKey,
        body: { is_public: true, publish_force: true },
      }),
      { eventId: fixture.eventId, sessionId: first },
    );

    expect(response.status).toBe(400);
    expect((await json(response)).message).toContain("publish_force_reason");
    expect((await rowFor(first))?.isPublic).toBe(false);
    expect(await ctx.db.select().from(gateOverrides)).toEqual([]);
    expect(await ctx.db.select().from(webhookDeliveries)).toEqual([]);
  });

  it("MUST NOT FIRE: a same-track overlap with different rooms and speakers stays advisory", async () => {
    const first = await addProgrammeSession(true, {
      startsAt: overlapStart,
      endsAt: overlapEnd,
      personId: fixture.speakerIds[0],
      roomId: fixture.roomIds[0],
      trackId: fixture.trackIds[0],
    });
    await addProgrammeSession(true, {
      startsAt: overlapStart,
      endsAt: overlapEnd,
      personId: fixture.speakerIds[1],
      roomId: fixture.roomIds[1],
      trackId: fixture.trackIds[0],
    });

    const response = await call(
      sessionAction as Handler,
      request("PUT", eventPath(`/sessions/${first}`), {
        key: writeKey,
        body: { is_public: true },
      }),
      { eventId: fixture.eventId, sessionId: first },
    );

    expect(response.status).toBe(200);
    expect((await rowFor(first))?.isPublic).toBe(true);
  });

  it("MUST FIRE: a session without a start time cannot be published", async () => {
    const id = await addProgrammeSession(true, { startsAt: null, endsAt: null });

    const response = await call(
      sessionAction as Handler,
      request("PUT", eventPath(`/sessions/${id}`), {
        key: writeKey,
        body: { is_public: true },
      }),
      { eventId: fixture.eventId, sessionId: id },
    );

    expect(response.status).toBe(400);
    const body = await json(response);
    expect(body.error).toBe("ValidationError");
    expect(body.message).toContain("time");
    expect((await rowFor(id))?.isPublic).toBe(false);
  });

  it("MUST NOT FIRE: an already-public session update is not re-gated", async () => {
    const { first } = await addSpeakerClash();
    await ctx.db.update(sessions).set({ isPublic: true }).where(eq(sessions.id, first));

    const response = await call(
      sessionAction as Handler,
      request("PUT", eventPath(`/sessions/${first}`), {
        key: writeKey,
        body: { title: "A public session can still be edited" },
      }),
      { eventId: fixture.eventId, sessionId: first },
    );

    expect(response.status).toBe(200);
    expect((await rowFor(first))?.title).toBe("A public session can still be edited");
  });

  it("MUST NOT FIRE: publish_force is a control flag, never a stored column", async () => {
    const { first } = await addSpeakerClash();
    const response = await call(
      sessionAction as Handler,
      request("PUT", eventPath(`/sessions/${first}`), {
        key: writeKey,
        body: {
          is_public: true,
          publish_force: true,
          publish_force_reason: "Speaker accepted the clash.",
        },
      }),
      { eventId: fixture.eventId, sessionId: first },
    );

    expect(response.status).toBe(200);
    const raw = ctx.sqlite
      .prepare("SELECT * FROM sessions WHERE id = ?")
      .get(first) as Record<string, unknown>;
    expect(Object.keys(raw)).not.toContain("publish_force");
    expect((raw as { is_public: number }).is_public).toBe(1);
  });

  it("MUST FIRE: the bulk update path refuses the same blocking conflict", async () => {
    const { first } = await addSpeakerClash();
    const response = await call(
      bulkAction as Handler,
      request("POST", eventPath("/sessions/bulk"), {
        key: writeKey,
        body: {
          operations: [{ action: "update", id: first, data: { is_public: true } }],
        },
      }),
      { eventId: fixture.eventId },
    );

    expect(response.status).toBe(200);
    const body = await json(response);
    expect(body.stats).toEqual({ total: 1, succeeded: 0, failed: 1 });
    expect(body.results[0]).toMatchObject({
      status: "error",
      error: { code: "conflict" },
    });
    expect(body.results[0].error.message).toContain("Speaker double-booked");
    expect((await rowFor(first))?.isPublic).toBe(false);
  });
});
