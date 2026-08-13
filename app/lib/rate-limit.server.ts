/**
 * D1-backed fixed-window limits for public write paths.
 *
 * Identifiers are HMACed before storage: the table retains an action/event
 * scope and an opaque digest, never raw email addresses, person ids, or IPs.
 * The atomic UPSERT puts the cap in SQL so concurrent requests cannot both
 * claim the final slot.
 */
import { appEnv, requireSecret } from "~/lib/env.server";

export interface RateLimitPolicy {
  limit: number;
  windowMs: number;
}

export const RATE_LIMIT_POLICIES = {
  magicLinkEmail: { limit: 5, windowMs: 15 * 60_000 },
  magicLinkIp: { limit: 20, windowMs: 15 * 60_000 },
  inlineSignupIp: { limit: 10, windowMs: 60 * 60_000 },
  cfpWrite: { limit: 120, windowMs: 10 * 60_000 },
  cfpSubmit: { limit: 10, windowMs: 60 * 60_000 },
  cfpUpload: { limit: 10, windowMs: 60 * 60_000 },
  apiUpload: { limit: 30, windowMs: 10 * 60_000 },
} as const satisfies Record<string, RateLimitPolicy>;

export type RateLimitDecision =
  | {
      allowed: true;
      limit: number;
      remaining: number;
      resetAt: number;
    }
  | {
      allowed: false;
      reason: "limited" | "unavailable";
      limit: number;
      retryAfter: number;
      resetAt: number;
    };

function secondsUntil(resetAt: number, now: number): number {
  return Math.max(1, Math.ceil((resetAt - now) / 1000));
}

async function keyedIdentifier(scope: string, identifier: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(requireSecret("RATE_LIMIT_SECRET")),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`v1\0${scope}\0${identifier}`),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Cloudflare overwrites cf-connecting-ip at the edge. Do not trust a
 * client-supplied x-forwarded-for fallback. Localhost gets one stable test/dev
 * bucket; a non-Cloudflare deployment without the header shares "unknown" and
 * therefore fails conservatively.
 */
export function requestClientIdentifier(request: Request): string {
  const edgeIp = request.headers.get("cf-connecting-ip")?.trim();
  if (edgeIp) return `ip:${edgeIp}`;

  try {
    const hostname = new URL(request.url).hostname;
    if (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1") {
      return "ip:local";
    }
  } catch {
    // Fall through to the shared fail-safe bucket.
  }
  return "ip:unknown";
}

export async function consumeRateLimit(input: {
  scope: string;
  identifier: string;
  policy: RateLimitPolicy;
  now?: number;
}): Promise<RateLimitDecision> {
  const now = input.now ?? Date.now();
  const windowStart = Math.floor(now / input.policy.windowMs) * input.policy.windowMs;
  const resetAt = windowStart + input.policy.windowMs;

  try {
    const identifierHash = await keyedIdentifier(input.scope, input.identifier);
    const db = appEnv().DB;

    // Expired windows are not useful evidence and must not grow without bound.
    await db
      .prepare("DELETE FROM rate_limit_windows WHERE expires_at <= ?")
      .bind(now)
      .run();

    const count = await db
      .prepare(
        `INSERT INTO rate_limit_windows
           (scope, identifier_hash, window_start, window_count, expires_at)
         VALUES (?, ?, ?, 1, ?)
         ON CONFLICT(scope, identifier_hash, window_start)
         DO UPDATE SET window_count = window_count + 1
         WHERE window_count < ?
         RETURNING window_count`,
      )
      .bind(
        input.scope,
        identifierHash,
        windowStart,
        resetAt + input.policy.windowMs,
        input.policy.limit,
      )
      .first("window_count");

    if (count === null) {
      return {
        allowed: false,
        reason: "limited",
        limit: input.policy.limit,
        retryAfter: secondsUntil(resetAt, now),
        resetAt,
      };
    }

    const used = Number(count);
    return {
      allowed: true,
      limit: input.policy.limit,
      remaining: Math.max(0, input.policy.limit - used),
      resetAt,
    };
  } catch (error) {
    console.error("[rate-limit] fail-closed:", error);
    return {
      allowed: false,
      reason: "unavailable",
      limit: input.policy.limit,
      retryAfter: 60,
      resetAt: now + 60_000,
    };
  }
}

export function rateLimitResponse(
  decision: Extract<RateLimitDecision, { allowed: false }>,
  message = "Too many requests. Please wait and try again.",
): Response {
  const status = decision.reason === "limited" ? 429 : 503;
  return new Response(
    decision.reason === "limited"
      ? message
      : "This public write is temporarily unavailable. Please try again shortly.",
    {
      status,
      headers: {
        "content-type": "text/plain; charset=utf-8",
        "retry-after": String(decision.retryAfter),
        "cache-control": "no-store",
      },
    },
  );
}

export async function enforceRateLimit(input: {
  scope: string;
  identifier: string;
  policy: RateLimitPolicy;
  now?: number;
  message?: string;
}): Promise<void> {
  const decision = await consumeRateLimit(input);
  if (!decision.allowed) throw rateLimitResponse(decision, input.message);
}
