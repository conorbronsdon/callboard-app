/**
 * `CallboardClient` itself has never had a direct test — every other test in
 * this tree (tools.test.ts) constructs it with an injected `fetchImpl`, which
 * is exactly the branch that CANNOT reproduce the bug this file guards
 * against.
 *
 * The one production construction site with no injected fetchImpl is
 * workers/mcp.ts:78-81 — a second, separately deployed Worker
 * (wrangler.mcp.jsonc) that nothing in this repo's test suite starts or
 * imports. Its comment (client.ts:155-164) records that the un-bound version
 * of this constructor threw "Illegal invocation" on every real MCP tool call
 * in production, once workerd's `fetch` receiver check saw `this` become the
 * client instance. `fetch.bind(globalThis)` already fixes it — this test is
 * what stops a future edit from quietly dropping the `.bind` and losing that
 * fix with nothing to catch it.
 */
import { describe, expect, it } from "vitest";

import { withStrictFetch } from "~/test/workerd-fetch";

import { CallboardApiError, CallboardClient } from "./client";

describe("the default fetch is called with the right receiver", () => {
  it("MUST-NOT-FIRE: no illegal invocation when fetchImpl is left to default (workerd regression)", async () => {
    await withStrictFetch(
      async (calls) => {
        // No fetchImpl — the exact construction shape workers/mcp.ts uses.
        const client = new CallboardClient({ origin: "https://callboard.test", apiKey: "cb_live_x" });
        const events = await client.listEvents();
        expect(events.results).toEqual([]);
        expect(calls).toHaveLength(1);
        expect(calls[0].receiver).toBe(globalThis);
        expect(calls[0].input).toBe("https://callboard.test/v1/events");
      },
      () =>
        new Response(
          JSON.stringify({ results: [], pagination: { currentPage: 1, pageSize: 25, totalPages: 0, totalResults: 0 } }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
  });

  it("MUST FIRE: the stub itself actually enforces the receiver (control for the test above)", async () => {
    // If this doesn't throw, the stub is a no-op and the test above proves
    // nothing. A raw method-style call — obj.fetchImpl(...) — is exactly the
    // shape that broke production before the `.bind(globalThis)` fix.
    await withStrictFetch(async () => {
      const obj = { fetchImpl: globalThis.fetch };
      // The stub throws synchronously (before any `await`), matching how a
      // branded platform method actually rejects a bad receiver — it is not
      // a rejected Promise.
      expect(() => obj.fetchImpl("https://callboard.test/v1/events")).toThrow(
        "Illegal invocation",
      );
    });
  });
});

describe("request()", () => {
  it("sends x-access-token and accept/content-type headers, and parses JSON", async () => {
    await withStrictFetch(
      async (calls) => {
        const client = new CallboardClient({
          origin: "https://callboard.test",
          apiKey: "cb_live_x",
        });
        const result = await client.getOpenApi();
        expect(result).toEqual({ ok: true });
        const [call] = calls;
        const headers = new Headers(call.init?.headers);
        expect(headers.get("x-access-token")).toBe("cb_live_x");
        expect(headers.get("accept")).toBe("application/json");
      },
      () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );
  });

  it("omits x-access-token when apiKey is null", async () => {
    await withStrictFetch(
      async (calls) => {
        const client = new CallboardClient({ origin: "https://callboard.test", apiKey: null });
        await client.getOpenApi();
        const headers = new Headers(calls[0].init?.headers);
        expect(headers.has("x-access-token")).toBe(false);
      },
      () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );
  });

  it("MUST-NOT-FIRE: a non-JSON 200 body raises InvalidUpstreamResponse rather than throwing raw", async () => {
    await withStrictFetch(
      async () => {
        const client = new CallboardClient({ origin: "https://callboard.test", apiKey: "k" });
        await expect(client.getOpenApi()).rejects.toThrow(CallboardApiError);
      },
      () => new Response("not json", { status: 200 }),
    );
  });
});
