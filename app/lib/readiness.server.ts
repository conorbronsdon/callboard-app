/**
 * Read-only readiness for the public write dependencies.
 *
 * This deliberately does not call consumeRateLimit: a probe must not create a
 * limiter window, magic-link token, session, or any other application row.
 * The zero-row SELECT validates the D1 binding plus the exact limiter columns
 * used by public writes without reading or changing user data.
 */
import { appEnv } from "~/lib/env.server";

const REQUIRED_RUNTIME_SECRETS = [
  "SESSION_SECRET",
  "MAGIC_LINK_SECRET",
  "RATE_LIMIT_SECRET",
] as const;

export type RuntimeReadiness = { ready: true } | { ready: false };

export async function checkRuntimeReadiness(): Promise<RuntimeReadiness> {
  try {
    const env = appEnv();

    for (const name of REQUIRED_RUNTIME_SECRETS) {
      if (!env[name]) throw new Error(`${name} is not configured`);
    }

    await env.DB.prepare(
      `SELECT scope, identifier_hash, window_start, window_count, expires_at
       FROM rate_limit_windows
       LIMIT 0`,
    ).all();

    return { ready: true };
  } catch (error) {
    console.error("[readiness] public writes unavailable:", error);
    return { ready: false };
  }
}
