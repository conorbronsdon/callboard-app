import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { webhookDeliveries, webhooks } from "~/db/schema";
import type { AppEnv } from "~/lib/env.server";
import { installTestDb, type TestDbContext } from "~/test/db";

import { webhookDriver } from "./config.server";
import {
  BuiltInDriver,
  SvixDriver,
  createWebhook,
  hmacSha256Hex,
  listWebhooks,
  validateWebhookUrl,
  type WebhookEnvelope,
} from "./webhooks.server";

let ctx: TestDbContext;

const envelope: WebhookEnvelope = {
  data: { title: "Pinned payload" },
  metadata: {
    event: "session.updated",
    resourceId: "session-123",
    eventId: "event-emission-123",
    occurredAt: "2026-08-12T20:00:00.000Z",
    version: 1,
  },
};

beforeEach(() => {
  ctx = installTestDb();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  ctx.close();
});

async function addEndpoint(id = "webhook-1") {
  await ctx.db.insert(webhooks).values({
    id,
    url: "https://receiver.test/hooks/callboard",
    secret: "top-secret",
  });
}

describe("webhook configuration and validation", () => {
  it("value-pins built-in unless both Svix values are present", () => {
    expect(webhookDriver({} as AppEnv)).toBe("builtin");
    expect(webhookDriver({ SVIX_TOKEN: "token" } as AppEnv)).toBe("builtin");
    expect(webhookDriver({ SVIX_APP_ID: "app" } as AppEnv)).toBe("builtin");
    expect(webhookDriver({ SVIX_TOKEN: "token", SVIX_APP_ID: "app" } as AppEnv)).toBe("svix");
  });

  it("MUST FIRE: rejects HTTP endpoints", () => {
    expect(validateWebhookUrl("http://receiver.test/hook")).toEqual({
      ok: false,
      error: "Webhook URLs must start with https://.",
    });
  });

  it("MUST NOT FIRE: accepts and normalizes HTTPS endpoints", () => {
    expect(validateWebhookUrl("https://receiver.test/hook")).toEqual({
      ok: true,
      url: "https://receiver.test/hook",
    });
  });

  it("returns the new secret once and never includes it in a later list", async () => {
    const created = await createWebhook("https://receiver.test/new");
    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error(created.error);
    expect(created.secret).toMatch(/^whsec_[0-9a-f]{64}$/);

    const listed = await listWebhooks();
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ id: created.webhook.id, url: created.webhook.url });
    expect("secret" in listed[0]).toBe(false);
    expect(JSON.stringify(listed)).not.toContain(created.secret);
  });
});

describe("built-in signing and retry policy", () => {
  it("pins HMAC-SHA256 to the exact expected lowercase hex", async () => {
    expect(await hmacSha256Hex("top-secret", '{"hello":"callboard"}')).toBe(
      "a0ae975d506eefb28c61733975f88a1ecad0ebe61593cfe44413d03b7a55a3ee",
    );
  });

  it("MUST FIRE: retries one 500 exactly once and signs the exact body", async () => {
    await addEndpoint();
    const calls: Array<{ body: string; signature: string | null }> = [];
    const fetchImpl: typeof fetch = vi.fn(async (_url, init) => {
      calls.push({
        body: String(init?.body),
        signature: new Headers(init?.headers).get("x-callboard-signature"),
      });
      return new Response(null, { status: calls.length === 1 ? 500 : 204 });
    });

    await new BuiltInDriver({ db: ctx.db, fetchImpl }).emit(envelope);

    expect(calls).toHaveLength(2);
    expect(calls[0].body).toBe(JSON.stringify(envelope));
    expect(calls[0].signature).toMatch(/^sha256=[0-9a-f]{64}$/);
    expect(calls[1]).toEqual(calls[0]);
    const rows = await ctx.db.select().from(webhookDeliveries);
    expect(rows).toMatchObject([{ status: "success", attempts: 2, lastError: null }]);
  });

  it("MUST NOT FIRE: a 400 is permanent and is attempted exactly once", async () => {
    await addEndpoint();
    const fetchImpl: typeof fetch = vi.fn(async () => new Response(null, { status: 400 }));

    await new BuiltInDriver({ db: ctx.db, fetchImpl }).emit(envelope);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [row] = await ctx.db.select().from(webhookDeliveries);
    expect(row).toMatchObject({ status: "failed", attempts: 1 });
    expect(row.lastError).toContain("HTTP 400");
  });

  it("MUST FIRE: a network failure gets exactly two attempts", async () => {
    await addEndpoint();
    const fetchImpl: typeof fetch = vi.fn(async () => {
      throw new Error("connection reset");
    });

    await new BuiltInDriver({ db: ctx.db, fetchImpl }).emit(envelope);

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const [row] = await ctx.db.select().from(webhookDeliveries);
    expect(row).toMatchObject({ status: "failed", attempts: 2, lastError: "connection reset" });
  });

  it("MUST NOT FIRE: zero active endpoints is a clean no-op", async () => {
    await addEndpoint();
    await ctx.db.update(webhooks).set({ active: false }).where(eq(webhooks.id, "webhook-1"));
    const fetchImpl: typeof fetch = vi.fn(async () => new Response(null, { status: 204 }));

    await new BuiltInDriver({ db: ctx.db, fetchImpl }).emit(envelope);

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(await ctx.db.select().from(webhookDeliveries)).toEqual([]);
  });
});

describe("Svix handoff", () => {
  it("posts the verified MessageIn shape once and logs a nullable webhook id", async () => {
    const fetchImpl: typeof fetch = vi.fn(async () => new Response(null, { status: 202 }));
    await new SvixDriver(
      { token: "svix-token", appId: "app_test" },
      { db: ctx.db, fetchImpl, now: new Date("2026-08-12T20:00:01.000Z") },
    ).emit(envelope);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = vi.mocked(fetchImpl).mock.calls[0];
    expect(url).toBe("https://api.svix.com/api/v1/app/app_test/msg");
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer svix-token");
    expect(new Headers(init?.headers).get("idempotency-key")).toBe("event-emission-123");
    expect(JSON.parse(String(init?.body))).toEqual({
      eventType: "session.updated",
      payload: envelope,
      eventId: "event-emission-123",
    });

    const [row] = await ctx.db.select().from(webhookDeliveries);
    expect(row).toMatchObject({
      webhookId: null,
      driver: "svix",
      event: "session.updated",
      resourceId: "session-123",
      status: "success",
      attempts: 1,
    });
  });
});
