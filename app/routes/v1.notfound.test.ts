/**
 * `/v1` answers in JSON even when the answer is "no such thing".
 *
 * The API was consistent about every failure except the most common one. A
 * wrong method got the envelope — `{ error, message }`, 405, `Allow` header. A
 * wrong PATH fell through to React Router's route matcher, missed, and rendered
 * the app's HTML error page: `<!DOCTYPE html>` with a "Page not found" heading
 * and a "Back to events" link, served to an integration that sent
 * `Accept: application/json`. Every client that does `await response.json()` on
 * a non-2xx — which is every client, because the other four status codes are
 * JSON — gets a SyntaxError about an unexpected `<` instead of the error it
 * was handed.
 *
 * The fix is a `/v1/*` splat that returns the same envelope as everything else.
 * The splat ranks BELOW every static `/v1` path in React Router, so it is a
 * floor, not an interceptor — the must-not-fire block below is what proves it,
 * by exercising a real route, a real 405 and a real 401 through the same
 * surface and finding them unchanged.
 *
 * The unknown-ID branches inside the existing handlers already returned JSON.
 * They are pinned here anyway: they are one refactor away from being routed
 * through generic machinery, and this file is where somebody would look.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { mintApiKey } from "~/lib/api/keys.server";
import { installTestDb, type TestDbContext } from "~/test/db";
import { seedDemoFixture, type DemoFixture } from "~/test/fixtures";

import { action as catchAllAction, loader as catchAllLoader } from "./v1.catchall";
import { action as eventsAction, loader as eventsLoader } from "./v1.events";
import { loader as sessionLoader } from "./v1.session";
import { loader as speakerLoader } from "./v1.speaker";

const ORIGIN = "https://callboard.test";

const ROUTES_SOURCE = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), "..", "routes.ts"),
  "utf8",
);

let ctx: TestDbContext;
let fixture: DemoFixture;
let readKey: string;

beforeEach(async () => {
  ctx = installTestDb();
  fixture = await seedDemoFixture(ctx.db);
  readKey = (
    await mintApiKey({
      eventId: fixture.eventId,
      name: "read-only",
      // `read:contacts`, not `read:speakers`: scopes are per-DOMAIN and the
      // speaker endpoints read the contacts domain. There is no `read:speakers`
      // scope, and a key carrying one gets 403 — which is the API behaving
      // correctly, not a 404 branch that failed to fire.
      scopes: ["read:events", "read:sessions", "read:contacts"],
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
  params: Record<string, string> = {},
  options: { key?: string | null } = {},
): Promise<Response> {
  const headers: Record<string, string> = { accept: "application/json" };
  const key = options.key === undefined ? readKey : options.key;
  if (key) headers["x-access-token"] = key;
  const request = new Request(`${ORIGIN}${path}`, { method, headers });
  try {
    const result = await handler({ request, params, context: {} });
    if (result instanceof Response) return result;
    throw new Error(`Handler returned a non-Response: ${JSON.stringify(result)}`);
  } catch (thrown) {
    if (thrown instanceof Response) return thrown;
    throw thrown;
  }
}

/** Every `/v1` response has to satisfy this, whatever the status. */
async function expectJsonEnvelope(response: Response, status: number) {
  expect(response.status).toBe(status);
  expect(response.headers.get("content-type")).toMatch(/application\/json/);
  const text = await response.text();
  expect(text.trimStart().startsWith("<")).toBe(false);
  const body = JSON.parse(text) as { error?: unknown; message?: unknown };
  expect(typeof body.error).toBe("string");
  expect(typeof body.message).toBe("string");
  expect((body.message as string).length).toBeGreaterThan(0);
  return body;
}

/* ─────────────────────────────────── must-fire: unknown paths are JSON ── */

describe("an unknown /v1 path", () => {
  it("answers JSON, not the HTML error page", async () => {
    const body = await expectJsonEnvelope(
      await call(catchAllLoader as Handler, "GET", "/v1/nope", { "*": "nope" }),
      404,
    );
    expect(body.error).toBe("NotFoundError");
  });

  it("answers JSON for a plausible-but-wrong collection path", async () => {
    // `/v1/events/<id>` is the path a client GUESSES from `/v1/events`; the
    // real one is `/v1/event/<id>/…`. This is the miss that actually happens.
    await expectJsonEnvelope(
      await call(catchAllLoader as Handler, "GET", `/v1/events/${fixture.eventId}`, {
        "*": `events/${fixture.eventId}`,
      }),
      404,
    );
  });

  it("answers JSON on a write method too", async () => {
    // A POST to a path that does not exist is still a missing path, not a
    // method problem — 404, in the envelope, not an HTML page.
    await expectJsonEnvelope(
      await call(catchAllAction as Handler, "POST", "/v1/nope", { "*": "nope" }),
      404,
    );
  });

  it("does not require a key to say a path is missing", async () => {
    // 401-before-404 would tell an anonymous caller that `/v1/nope` might
    // exist, and would make the common typo look like an auth problem.
    await expectJsonEnvelope(
      await call(catchAllLoader as Handler, "GET", "/v1/nope", { "*": "nope" }, { key: null }),
      404,
    );
  });

  it("is registered as a splat under /v1 in the route table", async () => {
    // The handler is only reachable if the route exists. Without this, every
    // assertion above tests a module nothing dispatches to.
    expect(ROUTES_SOURCE).toMatch(/route\(\s*"v1\/\*"\s*,\s*"routes\/v1\.catchall\.ts"/);
  });
});

/* ────────────────────── must-fire: unknown ids inside real routes are JSON ── */

describe("an unknown id inside a real /v1 route", () => {
  it("404s a missing session in the envelope", async () => {
    const body = await expectJsonEnvelope(
      await call(sessionLoader as Handler, "GET", `/v1/event/${fixture.eventId}/sessions/nope`, {
        eventId: fixture.eventId,
        sessionId: "nope",
      }),
      404,
    );
    expect(body.error).toBe("NotFoundError");
  });

  it("404s a missing speaker in the envelope", async () => {
    await expectJsonEnvelope(
      await call(speakerLoader as Handler, "GET", `/v1/event/${fixture.eventId}/speakers/nope`, {
        eventId: fixture.eventId,
        contactId: "nope",
      }),
      404,
    );
  });
});

/* ─────────────────────── must-NOT-fire: the rest of /v1 is unchanged ── */

describe("the splat does not shadow the API it sits under", () => {
  it("leaves a known route returning its data at 200", async () => {
    const response = await call(eventsLoader as Handler, "GET", "/v1/events");
    expect(response.status).toBe(200);
    const body = (await response.json()) as { results: unknown[]; pagination: unknown };
    expect(Array.isArray(body.results)).toBe(true);
    expect(body.results).toHaveLength(1);
    expect(body.pagination).toBeTruthy();
  });

  it("leaves 405 alone, Allow header included", async () => {
    // The status that was already right. A catch-all that swallowed method
    // errors would turn a fixable client bug into a wild goose chase.
    const response = await call(eventsAction as Handler, "POST", "/v1/events");
    const body = await expectJsonEnvelope(response, 405);
    expect(body.error).toBe("MethodNotAllowedError");
    expect(response.headers.get("allow")).toBe("GET");
  });

  it("leaves 401 alone for a real route with no key", async () => {
    const body = await expectJsonEnvelope(
      await call(eventsLoader as Handler, "GET", "/v1/events", {}, { key: null }),
      401,
    );
    expect(body.error).toBeTruthy();
  });

  it("leaves 401 alone for a real route with a junk key", async () => {
    await expectJsonEnvelope(
      await call(eventsLoader as Handler, "GET", "/v1/events", {}, { key: "cb_not_a_key" }),
      401,
    );
  });
});
