/**
 * `workers/mcp.ts` is a second, separately deployed Worker (wrangler.mcp.jsonc)
 * with no bindings of its own — before this file, nothing in the repo tested
 * it: no unit test imported it, no E2E spec requested `/mcp` or `/health`, and
 * no npm script starts or dry-runs its wrangler config. Its only production
 * `CallboardClient` construction site (line 78) is the exact shape that threw
 * "Illegal invocation" in a real deployed Worker before the `.bind(globalThis)`
 * fix landed (see app/lib/mcp/client.ts:155-164 and
 * app/lib/mcp/client.test.ts, which regression-tests that construction
 * directly). This file covers what's left in THIS module: origin validation,
 * the fallback-key precedence, and the isolate-reuse invariant.
 *
 * `workers/app.ts` (the main Worker) is NOT imported the same way — it calls
 * `createRequestHandler` against the Vite-only `virtual:react-router/server-build`
 * module at import time, which this plain-Node vitest config does not resolve.
 * `workers/mcp.ts` has no such dependency, so it can be imported directly.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { McpEnv } from "./mcp";

interface Descriptor {
  name: string;
  version: string;
  endpoint: string;
  upstream_origin: string;
  tools: string[];
  hint: string;
}

async function descriptorBody(response: Response): Promise<Descriptor> {
  return (await response.json()) as Descriptor;
}

/**
 * `cachedHandler` is real module-level state (workers/mcp.ts:46), so each test
 * that cares about isolate-reuse behavior needs a FRESH module instance —
 * otherwise a cache populated by an earlier test would leak into a later one
 * and the "changed inside one isolate" assertions would be testing stale
 * state, not the invariant.
 */
async function freshHandler() {
  vi.resetModules();
  const mod = await import("./mcp");
  return mod.default;
}

function fakeCtx(): ExecutionContext {
  return {
    waitUntil: () => undefined,
    passThroughOnException: () => undefined,
    props: {},
  } as unknown as ExecutionContext;
}

beforeEach(() => {
  vi.resetModules();
});

describe("descriptor endpoint (GET / and /health)", () => {
  it("reports the configured origin, tool names, and the x-access-token hint", async () => {
    const handler = await freshHandler();
    const env: McpEnv = { APP_ORIGIN: "https://demo.example.com" };
    const response = await handler.fetch(
      new Request("https://mcp.test/health"),
      env,
      fakeCtx(),
    );
    expect(response.status).toBe(200);
    const body = await descriptorBody(response);
    expect(body.upstream_origin).toBe("https://demo.example.com");
    expect(body.endpoint).toBe("/mcp");
    expect(Array.isArray(body.tools)).toBe(true);
    expect(body.tools.length).toBeGreaterThan(0);
    expect(body.hint).toContain("x-access-token");
  });

  it("falls back to the documented default origin when APP_ORIGIN is unset", async () => {
    const handler = await freshHandler();
    const response = await handler.fetch(new Request("https://mcp.test/"), {}, fakeCtx());
    const body = await descriptorBody(response);
    expect(body.upstream_origin).toBe("https://demo.callboardhq.com");
  });

  it("MUST-NOT-FIRE: descriptor never touches the isolate cache — repeat calls with different origins both succeed", async () => {
    const handler = await freshHandler();
    const first = await handler.fetch(
      new Request("https://mcp.test/health"),
      { APP_ORIGIN: "https://one.example.com" },
      fakeCtx(),
    );
    const second = await handler.fetch(
      new Request("https://mcp.test/health"),
      { APP_ORIGIN: "https://two.example.com" },
      fakeCtx(),
    );
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect((await descriptorBody(first)).upstream_origin).toBe("https://one.example.com");
    expect((await descriptorBody(second)).upstream_origin).toBe("https://two.example.com");
  });
});

describe("resolveConfig origin validation", () => {
  const bad: Record<string, string> = {
    "http, not https": "http://demo.example.com",
    "has a path": "https://demo.example.com/mcp",
    "has a query string": "https://demo.example.com/?x=1",
    "has a hash": "https://demo.example.com/#frag",
    "carries credentials": "https://user:pass@demo.example.com",
  };

  for (const [label, origin] of Object.entries(bad)) {
    it(`MUST FIRE: rejects an APP_ORIGIN that ${label}`, async () => {
      const handler = await freshHandler();
      await expect(
        handler.fetch(new Request("https://mcp.test/health"), { APP_ORIGIN: origin }, fakeCtx()),
      ).rejects.toThrow(/HTTPS origin/);
    });
  }

  it("MUST-NOT-FIRE complement: an origin with none of those defects is accepted", async () => {
    const handler = await freshHandler();
    const response = await handler.fetch(
      new Request("https://mcp.test/health"),
      { APP_ORIGIN: "https://demo.example.com" },
      fakeCtx(),
    );
    expect(response.status).toBe(200);
  });
});

describe("isolate-reuse invariant", () => {
  it("MUST FIRE: a second request with a different origin, after the isolate cache is primed, throws rather than silently switching config", async () => {
    const handler = await freshHandler();
    // Any non-health path reaches handlerFor() and primes cachedHandler —
    // handlerFor() sets the cache BEFORE invoking the MCP transport, so this
    // call priming the cache does not depend on a well-formed MCP body.
    await handler
      .fetch(
        new Request("https://mcp.test/mcp", { method: "POST", body: "{}" }),
        { APP_ORIGIN: "https://one.example.com" },
        fakeCtx(),
      )
      .catch(() => undefined); // The MCP transport itself may reject "{}"; irrelevant here.

    await expect(
      handler.fetch(
        new Request("https://mcp.test/mcp", { method: "POST", body: "{}" }),
        { APP_ORIGIN: "https://two.example.com" },
        fakeCtx(),
      ),
    ).rejects.toThrow("MCP Worker configuration changed inside one isolate.");
  });

  it("MUST-NOT-FIRE complement: repeat requests with the SAME origin never trip the invariant", async () => {
    const handler = await freshHandler();
    const env: McpEnv = { APP_ORIGIN: "https://one.example.com" };
    await handler
      .fetch(new Request("https://mcp.test/mcp", { method: "POST", body: "{}" }), env, fakeCtx())
      .catch(() => undefined);

    await expect(
      handler.fetch(new Request("https://mcp.test/mcp", { method: "POST", body: "{}" }), env, fakeCtx()),
    ).resolves.not.toThrow();
  });
});
