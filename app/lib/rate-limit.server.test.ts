import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { installTestDb, type TestDbContext } from "~/test/db";

import {
  consumeRateLimit,
  rateLimitResponse,
  requestClientIdentifier,
} from "./rate-limit.server";

let ctx: TestDbContext;
const policy = { limit: 2, windowMs: 60_000 };
const now = 1_700_000_020_000;

beforeEach(() => {
  ctx = installTestDb({ RATE_LIMIT_SECRET: "test-rate-limit-secret" });
});
afterEach(() => ctx.close());

describe("D1 rate limiter — must fire", () => {
  it("rejects the request after the atomic window cap and returns Retry-After", async () => {
    const input = {
      scope: "magic-link:email",
      identifier: "person@example.com",
      policy,
      now,
    };

    expect((await consumeRateLimit(input)).allowed).toBe(true);
    expect((await consumeRateLimit(input)).allowed).toBe(true);

    const denied = await consumeRateLimit(input);
    expect(denied).toMatchObject({ allowed: false, reason: "limited", retryAfter: 20 });

    if (denied.allowed) throw new Error("expected a denied decision");
    const response = rateLimitResponse(denied);
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("20");
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("fails closed with 503 when D1 is unavailable", async () => {
    ctx.close();
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const denied = await consumeRateLimit({
        scope: "cfp:event-a:write",
        identifier: "person-1",
        policy,
        now,
      });
      expect(denied).toMatchObject({
        allowed: false,
        reason: "unavailable",
        retryAfter: 60,
      });
      if (denied.allowed) throw new Error("expected a denied decision");
      expect(rateLimitResponse(denied).status).toBe(503);
    } finally {
      // afterEach closes defensively; replace it with a new live context.
      ctx = installTestDb({ RATE_LIMIT_SECRET: "test-rate-limit-secret" });
      error.mockRestore();
    }
  });
});

describe("D1 rate limiter — must NOT fire", () => {
  it("allows the final slot and resets in the next bounded window", async () => {
    const input = {
      scope: "cfp:event-a:submit",
      identifier: "person-1",
      policy,
      now,
    };

    const first = await consumeRateLimit(input);
    const last = await consumeRateLimit(input);
    const nextWindow = await consumeRateLimit({ ...input, now: now + policy.windowMs });

    expect(first).toMatchObject({ allowed: true, remaining: 1 });
    expect(last).toMatchObject({ allowed: true, remaining: 0 });
    expect(nextWindow).toMatchObject({ allowed: true, remaining: 1 });
  });

  it("isolates the same identifier by event scope", async () => {
    for (let count = 0; count < policy.limit; count += 1) {
      expect(
        (
          await consumeRateLimit({
            scope: "cfp:event-a:write",
            identifier: "person-1",
            policy,
            now,
          })
        ).allowed,
      ).toBe(true);
    }

    expect(
      (
        await consumeRateLimit({
          scope: "cfp:event-b:write",
          identifier: "person-1",
          policy,
          now,
        })
      ).allowed,
    ).toBe(true);
  });

  it("stores only a keyed digest, never the raw identifier", async () => {
    const identifier = "sensitive@example.com";
    await consumeRateLimit({
      scope: "magic-link:email",
      identifier,
      policy,
      now,
    });

    const row = ctx.sqlite
      .prepare("SELECT identifier_hash FROM rate_limit_windows")
      .get() as { identifier_hash: string };

    expect(row.identifier_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(row.identifier_hash).not.toContain("sensitive");
    expect(
      ctx.sqlite
        .prepare("SELECT count(*) AS n FROM rate_limit_windows WHERE identifier_hash = ?")
        .get(identifier),
    ).toEqual({ n: 0 });
  });
});

describe("requestClientIdentifier", () => {
  it("uses Cloudflare's edge-authored address", () => {
    const request = new Request("https://example.com/login", {
      headers: { "cf-connecting-ip": "203.0.113.7" },
    });
    expect(requestClientIdentifier(request)).toBe("ip:203.0.113.7");
  });

  it("does not trust x-forwarded-for outside localhost", () => {
    const request = new Request("https://example.com/login", {
      headers: { "x-forwarded-for": "203.0.113.8" },
    });
    expect(requestClientIdentifier(request)).toBe("ip:unknown");
  });
});
