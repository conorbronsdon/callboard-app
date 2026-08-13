/**
 * API keys: mint, list, revoke, resolve.
 *
 * Storage rules (schema `api_keys`, WS0):
 * - only the SHA-256 of the key is persisted — a DB leak hands out nothing;
 * - the plaintext is returned exactly once, from `mintApiKey`, and the admin
 *   screen renders it once from `actionData`. It is never written anywhere;
 * - `keySuffix` (last 4 chars) is the only fragment stored, so a human can tell
 *   two keys apart in the UI.
 *
 * The scope VOCABULARY lives in the pure `./scopes` module and is re-exported
 * here, so a component can import it without dragging drizzle and
 * `cloudflare:workers` into the browser bundle. See that file's header for the
 * hydration failure that caused.
 */
import { and, asc, eq, isNull } from "drizzle-orm";

import { getDb } from "~/db/client.server";
import { apiKeys } from "~/db/schema";
import { hashToken } from "~/lib/auth/tokens";

import { API_SCOPES, type ApiScope } from "./scopes";

export {
  API_SCOPES,
  READ_SCOPES,
  SCOPE_PRESETS,
  isApiScope,
  type ApiScope,
  type ScopePreset,
} from "./scopes";

export type ApiKeyRow = typeof apiKeys.$inferSelect;

/**
 * `cb_` + 32 random bytes as base64url (43 chars).
 *
 * The prefix is deliberate: a secret scanner (GitHub's, or `git grep`) can find
 * a leaked key by its prefix, and a human pasting one into the wrong box can see
 * what it is. 256 bits of entropy from `crypto.getRandomValues`.
 */
export const API_KEY_PREFIX = "cb_";

export function generateApiKeyPlaintext(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const base64url = btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  return `${API_KEY_PREFIX}${base64url}`;
}

export interface MintedApiKey {
  /** Shown ONCE. Never stored, never logged. */
  plaintext: string;
  key: ApiKeyRow;
}

export async function mintApiKey(options: {
  eventId: string;
  name: string;
  scopes: ApiScope[];
}): Promise<MintedApiKey> {
  const plaintext = generateApiKeyPlaintext();
  const [key] = await getDb()
    .insert(apiKeys)
    .values({
      eventId: options.eventId,
      name: options.name.trim() || "Untitled key",
      keyHash: await hashToken(plaintext),
      keySuffix: plaintext.slice(-4),
      // Deduplicated and ordered, so two keys with the same intent compare equal.
      scopes: API_SCOPES.filter((scope) => options.scopes.includes(scope)),
    })
    .returning();
  return { plaintext, key };
}

/** Keys for an event, newest first. Revoked ones are included and marked. */
export async function listApiKeys(eventId: string): Promise<ApiKeyRow[]> {
  const rows = await getDb()
    .select()
    .from(apiKeys)
    .where(eq(apiKeys.eventId, eventId))
    .orderBy(asc(apiKeys.createdAt));
  return rows.reverse();
}

/** Revoke by id, scoped to the event so an admin cannot revoke another event's key. */
export async function revokeApiKey(eventId: string, keyId: string): Promise<boolean> {
  const rows = await getDb()
    .update(apiKeys)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(apiKeys.id, keyId),
        eq(apiKeys.eventId, eventId),
        isNull(apiKeys.revokedAt),
      ),
    )
    .returning({ id: apiKeys.id });
  return rows.length > 0;
}

/**
 * Resolve a presented key to its row. Revoked keys resolve to null — the check
 * is in the WHERE clause, not in a caller's `if`, so no route can forget it.
 */
export async function findApiKeyByPlaintext(plaintext: string): Promise<ApiKeyRow | null> {
  if (!plaintext) return null;
  const hash = await hashToken(plaintext);
  const row = await getDb().query.apiKeys.findFirst({
    where: and(eq(apiKeys.keyHash, hash), isNull(apiKeys.revokedAt)),
  });
  return row ?? null;
}

/**
 * How stale `lastUsedAt` may get before we spend a write refreshing it.
 *
 * Recording every single call would put a D1 write on the read path of the
 * busiest endpoints — the exact cost Sessionboard's 3-minute read cache exists
 * to dodge. A minute of resolution is plenty for "is this key still in use?".
 */
export const LAST_USED_REFRESH_MS = 60_000;

export async function touchApiKey(key: ApiKeyRow, now: Date = new Date()): Promise<void> {
  const last = key.lastUsedAt?.getTime() ?? 0;
  if (now.getTime() - last < LAST_USED_REFRESH_MS) return;
  await getDb()
    .update(apiKeys)
    .set({ lastUsedAt: now })
    .where(eq(apiKeys.id, key.id));
}
