/**
 * Optional outbound webhooks behind one seam.
 *
 * Built-in delivery fans an event out to active D1 endpoints, signs the exact
 * JSON string sent, retries network/5xx failures once, and records the final
 * outcome. Svix mode is selected only when both credentials exist; it never
 * reads local endpoints and records only Callboard's one handoff to Svix.
 *
 * Delivery failures, configuration failures, and delivery-log failures never
 * escape into a caller. In a real request, emitWebhook registers the complete
 * promise with Cloudflare's importable waitUntil through background.server.ts.
 * In direct tests, cron, and scripts there is no request context, so it awaits
 * the same work and leaves deterministic rows for the caller to inspect.
 */
import { desc, eq } from "drizzle-orm";

import { getDb, type DB } from "~/db/client.server";
import { webhookDeliveries, webhooks } from "~/db/schema";

import { waitUntilOrAwait } from "./background.server";
import { svixConfig, webhookDriver, type SvixConfig } from "./config.server";

export type WebhookEventType =
  | "session.created"
  | "session.updated"
  | "session.deleted"
  | "session.published"
  | "contact.created"
  | "contact.updated"
  | "contact.merged"
  | "decision.committed";

export interface WebhookEnvelope {
  data: Record<string, unknown>;
  metadata: {
    event: WebhookEventType;
    resourceId: string;
    eventId: string;
    occurredAt: string;
    version: 1;
  };
}

export interface WebhookView {
  id: string;
  url: string;
  active: boolean;
  createdAt: Date;
}

export interface DeliveryView {
  id: string;
  webhookId: string | null;
  driver: "builtin" | "svix";
  event: string;
  resourceId: string;
  status: "success" | "failed";
  attempts: number;
  lastError: string | null;
  createdAt: Date;
  updatedAt: Date;
}

type FetchLike = typeof fetch;

interface DriverDeps {
  db?: DB;
  fetchImpl?: FetchLike;
  now?: Date;
}

interface DeliveryResult {
  status: "success" | "failed";
  attempts: number;
  lastError: string | null;
}

const encoder = new TextEncoder();

function hex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** HMAC-SHA256 over the exact UTF-8 body bytes, encoded as lowercase hex. */
export async function hmacSha256Hex(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return hex(await crypto.subtle.sign("HMAC", key, encoder.encode(body)));
}

export function generateWebhookSecret(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return `whsec_${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

export function validateWebhookUrl(raw: string):
  | { ok: true; url: string }
  | { ok: false; error: string } {
  try {
    const url = new URL(raw.trim());
    if (url.protocol !== "https:") {
      return { ok: false, error: "Webhook URLs must start with https://." };
    }
    return { ok: true, url: url.toString() };
  } catch {
    return { ok: false, error: "Enter a valid HTTPS webhook URL." };
  }
}

async function recordDelivery(
  db: DB,
  input: {
    webhookId: string | null;
    driver: "builtin" | "svix";
    envelope: WebhookEnvelope;
    result: DeliveryResult;
    now: Date;
  },
): Promise<void> {
  try {
    await db.insert(webhookDeliveries).values({
      webhookId: input.webhookId,
      driver: input.driver,
      event: input.envelope.metadata.event,
      resourceId: input.envelope.metadata.resourceId,
      status: input.result.status,
      attempts: input.result.attempts,
      lastError: input.result.lastError,
      createdAt: input.now,
      updatedAt: input.now,
    });
  } catch (error) {
    console.error(JSON.stringify({
      message: "webhook delivery log failed",
      driver: input.driver,
      event: input.envelope.metadata.event,
      resourceId: input.envelope.metadata.resourceId,
      error: error instanceof Error ? error.message : String(error),
    }));
  }
}

async function postBuiltIn(
  endpoint: { url: string; secret: string },
  body: string,
  fetchImpl: FetchLike,
): Promise<DeliveryResult> {
  const signature = await hmacSha256Hex(endpoint.secret, body);
  let lastError = "Unknown delivery failure.";

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const response = await fetchImpl(endpoint.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-callboard-signature": `sha256=${signature}`,
        },
        body,
      });
      if (response.ok) return { status: "success", attempts: attempt, lastError: null };

      lastError = `HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ""}`;
      // A 4xx is a permanent receiver error. Retrying it only burns time.
      if (response.status >= 400 && response.status < 500) {
        return { status: "failed", attempts: attempt, lastError };
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
  }

  return { status: "failed", attempts: 2, lastError };
}

export class BuiltInDriver {
  constructor(private readonly deps: DriverDeps = {}) {}

  async emit(envelope: WebhookEnvelope): Promise<void> {
    const db = this.deps.db ?? getDb();
    const fetchImpl = this.deps.fetchImpl ?? fetch;
    const rows = await db
      .select({ id: webhooks.id, url: webhooks.url, secret: webhooks.secret })
      .from(webhooks)
      .where(eq(webhooks.active, true));

    const body = JSON.stringify(envelope);
    for (const row of rows) {
      let result: DeliveryResult;
      try {
        result = await postBuiltIn(row, body, fetchImpl);
      } catch (error) {
        result = {
          status: "failed",
          attempts: 1,
          lastError: error instanceof Error ? error.message : String(error),
        };
      }
      await recordDelivery(db, {
        webhookId: row.id,
        driver: "builtin",
        envelope,
        result,
        now: this.deps.now ?? new Date(),
      });
    }
  }
}

export class SvixDriver {
  constructor(
    private readonly config: SvixConfig,
    private readonly deps: DriverDeps = {},
  ) {}

  async emit(envelope: WebhookEnvelope): Promise<void> {
    const db = this.deps.db ?? getDb();
    const fetchImpl = this.deps.fetchImpl ?? fetch;
    let result: DeliveryResult;
    try {
      // Verified 2026-08-12 against Svix's live API reference and official TS
      // SDK: POST /api/v1/app/{app_id}/msg (no trailing slash), MessageIn fields
      // eventType/payload/eventId, Bearer auth, and Idempotency-Key.
      const response = await fetchImpl(
        `https://api.svix.com/api/v1/app/${encodeURIComponent(this.config.appId)}/msg`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${this.config.token}`,
            "content-type": "application/json",
            "idempotency-key": envelope.metadata.eventId,
          },
          body: JSON.stringify({
            eventType: envelope.metadata.event,
            payload: envelope,
            eventId: envelope.metadata.eventId,
          }),
        },
      );
      result = response.ok
        ? { status: "success", attempts: 1, lastError: null }
        : {
            status: "failed",
            attempts: 1,
            lastError: `HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ""}`,
          };
    } catch (error) {
      result = {
        status: "failed",
        attempts: 1,
        lastError: error instanceof Error ? error.message : String(error),
      };
    }
    await recordDelivery(db, {
      webhookId: null,
      driver: "svix",
      envelope,
      result,
      now: this.deps.now ?? new Date(),
    });
  }
}

async function deliver(envelope: WebhookEnvelope): Promise<void> {
  if (webhookDriver() === "svix") {
    const config = svixConfig();
    // Selection and config share the same predicate; retain the guard so a
    // future refactor still fails closed instead of manufacturing credentials.
    if (!config) return;
    await new SvixDriver(config).emit(envelope);
    return;
  }
  await new BuiltInDriver().emit(envelope);
}

export async function emitWebhook(
  event: WebhookEventType,
  resourceId: string,
  data: Record<string, unknown>,
): Promise<void> {
  try {
    const envelope: WebhookEnvelope = {
      data,
      metadata: {
        event,
        resourceId,
        eventId: crypto.randomUUID(),
        occurredAt: new Date().toISOString(),
        version: 1,
      },
    };
    const work = deliver(envelope).catch((error) => {
      console.error(JSON.stringify({
        message: "webhook emission failed",
        event,
        resourceId,
        error: error instanceof Error ? error.message : String(error),
      }));
    });
    await waitUntilOrAwait(work);
  } catch (error) {
    console.error(JSON.stringify({
      message: "webhook scheduling failed",
      event,
      resourceId,
      error: error instanceof Error ? error.message : String(error),
    }));
  }
}

export async function createWebhook(rawUrl: string): Promise<
  | { ok: true; webhook: WebhookView; secret: string }
  | { ok: false; error: string }
> {
  const checked = validateWebhookUrl(rawUrl);
  if (!checked.ok) return checked;
  const secret = generateWebhookSecret();
  const [row] = await getDb()
    .insert(webhooks)
    .values({ url: checked.url, secret })
    .returning({
      id: webhooks.id,
      url: webhooks.url,
      active: webhooks.active,
      createdAt: webhooks.createdAt,
    });
  return { ok: true, webhook: row, secret };
}

export async function listWebhooks(): Promise<WebhookView[]> {
  return getDb()
    .select({
      id: webhooks.id,
      url: webhooks.url,
      active: webhooks.active,
      createdAt: webhooks.createdAt,
    })
    .from(webhooks)
    .orderBy(desc(webhooks.createdAt));
}

export async function setWebhookActive(id: string, active: boolean): Promise<boolean> {
  const rows = await getDb()
    .update(webhooks)
    .set({ active })
    .where(eq(webhooks.id, id))
    .returning({ id: webhooks.id });
  return rows.length > 0;
}

export async function deleteWebhook(id: string): Promise<boolean> {
  const rows = await getDb()
    .delete(webhooks)
    .where(eq(webhooks.id, id))
    .returning({ id: webhooks.id });
  return rows.length > 0;
}

export async function listWebhookDeliveries(limit = 50): Promise<DeliveryView[]> {
  return getDb()
    .select({
      id: webhookDeliveries.id,
      webhookId: webhookDeliveries.webhookId,
      driver: webhookDeliveries.driver,
      event: webhookDeliveries.event,
      resourceId: webhookDeliveries.resourceId,
      status: webhookDeliveries.status,
      attempts: webhookDeliveries.attempts,
      lastError: webhookDeliveries.lastError,
      createdAt: webhookDeliveries.createdAt,
      updatedAt: webhookDeliveries.updatedAt,
    })
    .from(webhookDeliveries)
    .orderBy(desc(webhookDeliveries.createdAt))
    .limit(limit);
}
