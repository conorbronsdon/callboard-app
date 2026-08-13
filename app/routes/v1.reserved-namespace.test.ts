/**
 * `/v1` write side and the `__` reserved namespace inside `sessions.answers`.
 *
 * `serialize.ts` strips every `__`-prefixed key on the way OUT. The write side
 * had no equivalent, and `updateSession` replaces `answers` wholesale, which
 * produced two defects that are the same defect from opposite ends:
 *
 *  - a caller could POST or PUT their own `__capture`, and #87 turned that blob
 *    into trust-bearing display copy — "Captured on the speaker's behalf by X"
 *    on `/admin/submissions/:id`, naming whoever the JSON said;
 *  - the obvious integration loop (GET, edit `custom_fields`, PUT) silently
 *    ERASED a real `__capture`, because the GET never showed it and the PUT
 *    replaced the whole object.
 *
 * Both directions are asserted, and each one has the control that a fix for the
 * other would break: stripping alone destroys provenance on round trip, merging
 * alone leaves it forgeable.
 *
 * Requires an admin-minted, event-scoped write key, so this was never a public
 * hole — but `admin.apikeys.tsx` hands those out and the display copy says
 * something about a named human.
 */
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { sessions } from "~/db/schema";
import { CAPTURE_KEY, captureProvenance } from "~/lib/capture";
import { mintApiKey } from "~/lib/api/keys.server";
import { installTestDb, type TestDbContext } from "~/test/db";
import { seedDemoFixture, type DemoFixture } from "~/test/fixtures";

import { action as createAction } from "./v1.sessions.create";
import { action as sessionAction, loader as sessionLoader } from "./v1.session";

const ORIGIN = "https://callboard.test";

/** A real capture block, the shape `captureProvenanceFor` writes. */
const REAL_CAPTURE = {
  source: "email",
  capturedAt: 1_760_000_000_000,
  byPersonId: "the-real-organizer",
  byName: "Rae Organizer",
  contactName: null,
  contactNote: null,
};

let ctx: TestDbContext;
let fixture: DemoFixture;
let writeKey: string;

beforeEach(async () => {
  ctx = installTestDb();
  fixture = await seedDemoFixture(ctx.db);
  writeKey = (
    await mintApiKey({
      eventId: fixture.eventId,
      name: "read-write",
      scopes: ["read:events", "read:sessions", "write:sessions"],
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
  method: string,
  path: string,
  params: Record<string, string>,
  body?: unknown,
): Promise<Response> {
  const headers: Record<string, string> = { "x-access-token": writeKey };
  if (body !== undefined) headers["content-type"] = "application/json";
  const request = new Request(`${ORIGIN}${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  try {
    const result = await handler({ request, params, context: {} });
    if (result instanceof Response) return result;
    throw new Error(`Handler returned a non-Response: ${JSON.stringify(result)}`);
  } catch (thrown) {
    if (thrown instanceof Response) return thrown;
    throw thrown;
  }
}

const storedAnswers = async (sessionId: string): Promise<Record<string, unknown>> =>
  ((
    await ctx.db.query.sessions.findFirst({ where: eq(sessions.id, sessionId) })
  )?.answers ?? {}) as Record<string, unknown>;

const readSession = (sessionId: string) =>
  call(sessionLoader as Handler, "GET", `/v1/event/${fixture.eventId}/sessions/${sessionId}`, {
    eventId: fixture.eventId,
    sessionId,
  });

const putSession = (sessionId: string, body: unknown) =>
  call(
    sessionAction as Handler,
    "PUT",
    `/v1/event/${fixture.eventId}/sessions/${sessionId}`,
    { eventId: fixture.eventId, sessionId },
    body,
  );

/** Give a seeded abstract a genuine capture block to protect. */
async function withRealCapture(sessionId: string): Promise<void> {
  const existing = await storedAnswers(sessionId);
  await ctx.db
    .update(sessions)
    .set({ answers: { ...existing, [CAPTURE_KEY]: REAL_CAPTURE } })
    .where(eq(sessions.id, sessionId));
}

/* ─────────────────────────────── must-fire: forgery does not land ───── */

describe("a client cannot write into the reserved namespace", () => {
  it("drops a forged __capture on PUT", async () => {
    const sessionId = fixture.abstractIds[3];

    const response = await putSession(sessionId, {
      answers: {
        title: "Cost modelling for multi-agent systems",
        [CAPTURE_KEY]: { ...REAL_CAPTURE, byName: "Someone Who Never Touched This" },
      },
    });
    expect(response.status).toBe(200);

    const answers = await storedAnswers(sessionId);
    expect(answers[CAPTURE_KEY]).toBeUndefined();
    // The banner reads the parsed block, so this is the assertion that matters.
    expect(captureProvenance(answers)).toBeNull();
    // Must-still-fire: the legitimate part of the same write DID land.
    expect(answers.title).toBe("Cost modelling for multi-agent systems");
  });

  it("drops a forged reserved key sent as a custom_fields entry", async () => {
    // The other accepted body shape. A filter applied to only one of them is a
    // filter that is not applied.
    const sessionId = fixture.abstractIds[3];

    const response = await putSession(sessionId, {
      custom_fields: [
        { key: "title", value: "Through the array form" },
        { key: CAPTURE_KEY, value: REAL_CAPTURE },
        { key: "__content", value: { forged: true } },
      ],
    });
    expect(response.status).toBe(200);

    const answers = await storedAnswers(sessionId);
    expect(Object.keys(answers).filter((key) => key.startsWith("__"))).toEqual([]);
    expect(answers.title).toBe("Through the array form");
  });

  it("drops a forged __capture on CREATE", async () => {
    const response = await call(
      createAction as Handler,
      "POST",
      `/v1/event/${fixture.eventId}/sessions`,
      { eventId: fixture.eventId },
      {
        title: "Minted by an integration",
        is_abstract: true,
        answers: { abstract: "Body.", [CAPTURE_KEY]: REAL_CAPTURE },
      },
    );
    expect(response.status).toBe(201);

    const created = (await response.json()) as { id: string };
    const answers = await storedAnswers(created.id);
    expect(captureProvenance(answers)).toBeNull();
    expect(answers.abstract).toBe("Body.");
  });
});

/* ───────────────────── must-fire: a real capture survives the loop ───── */

describe("a stored reserved key survives a client update", () => {
  it("preserves __capture across the GET -> edit -> PUT loop the API invites", async () => {
    const sessionId = fixture.abstractIds[3];
    await withRealCapture(sessionId);

    // Exactly what an integration would do: read, edit what it can see, write.
    const read = (await (await readSession(sessionId)).json()) as {
      custom_fields: { key: string; value: unknown }[];
      updated_at: string;
    };
    expect(read.custom_fields.map((field) => field.key)).not.toContain(CAPTURE_KEY);

    const edited = read.custom_fields.map((field) =>
      field.key === "takeaways" ? { ...field, value: "Rewritten by the integration." } : field,
    );
    const response = await putSession(sessionId, {
      custom_fields: edited,
      updated_at: read.updated_at,
    });
    expect(response.status).toBe(200);

    const answers = await storedAnswers(sessionId);
    expect(captureProvenance(answers)).toMatchObject({
      byPersonId: "the-real-organizer",
      byName: "Rae Organizer",
      source: "email",
    });
    // Must-still-fire: the client's own edit landed. A merge that simply
    // ignored `answers` would pass the assertion above and break the endpoint.
    expect(answers.takeaways).toBe("Rewritten by the integration.");
  });

  it("keeps the stored block when a client PUTs a forged one over it", async () => {
    // Strip and merge together: the forgery is dropped AND the real block is
    // put back, so the loser of the collision is always the caller.
    const sessionId = fixture.abstractIds[3];
    await withRealCapture(sessionId);

    expect(
      (
        await putSession(sessionId, {
          answers: { title: "t", [CAPTURE_KEY]: { ...REAL_CAPTURE, byName: "Impostor" } },
        })
      ).status,
    ).toBe(200);

    expect(captureProvenance(await storedAnswers(sessionId))).toMatchObject({
      byName: "Rae Organizer",
    });
  });

  it("must NOT fire: `answers: null` is read as absent, so nothing is cleared", async () => {
    // Pinning pre-existing behaviour rather than asserting a wish. `pick`
    // treats an explicit null as "the field was not sent", so the blob is
    // untouched — which is why the merge above only ever runs on a real object.
    const sessionId = fixture.abstractIds[3];
    await withRealCapture(sessionId);
    const before = await storedAnswers(sessionId);

    expect((await putSession(sessionId, { answers: null })).status).toBe(200);

    const answers = await storedAnswers(sessionId);
    expect(answers).toEqual(before);
    expect(captureProvenance(answers)).toMatchObject({ byName: "Rae Organizer" });
  });

  it("must NOT fire: a PUT that omits answers leaves the blob alone", async () => {
    // The control for the merge. A merge that ran unconditionally would
    // rewrite `answers` on every title-only update.
    const sessionId = fixture.abstractIds[3];
    const before = await storedAnswers(sessionId);

    expect((await putSession(sessionId, { title: "Title only" })).status).toBe(200);

    expect(await storedAnswers(sessionId)).toEqual(before);
  });

  it("must NOT fire: a session with no reserved keys round-trips unchanged", async () => {
    // The control for the strip. Ordinary answers must be untouched by any of
    // this, including keys with a single leading underscore.
    const sessionId = fixture.abstractIds[3];

    expect(
      (
        await putSession(sessionId, {
          answers: { title: "t", abstract: "a", _internal_looking: "kept" },
        })
      ).status,
    ).toBe(200);

    expect(await storedAnswers(sessionId)).toEqual({
      title: "t",
      abstract: "a",
      _internal_looking: "kept",
    });
  });
});
