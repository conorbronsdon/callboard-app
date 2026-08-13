/**
 * Magic-link token primitives. Pure: WebCrypto only, no bindings, no I/O —
 * so this file is unit-testable in plain Node (see tokens.test.ts).
 *
 * Token wire format: `base64url(json(payload)).base64url(hmac-sha256)`.
 * The payload is readable by design (it carries no secret); the signature is
 * what makes it unforgeable. Single-use is enforced in the DB, not here.
 */

/**
 * 15 minutes. Deliberately MULTI-USE inside the TTL: Outlook Safe Links, the
 * Gmail image proxy, and antivirus scanners fetch links before the human clicks,
 * and a strictly single-use token is dead on arrival for those recipients.
 * Short TTL + revoke-on-login is the trade we take instead.
 */
export const MAGIC_LINK_TTL_MS = 15 * 60 * 1000;

export interface MagicLinkPayload {
  /** Token id — the DB row that tracks expiry, revocation, and use count. */
  jti: string;
  /** Subject: the person's id. */
  sub: string;
  /** Expiry, epoch ms. */
  exp: number;
}

export type VerifyFailure =
  | "malformed"
  | "bad_signature"
  | "expired";

export type VerifyResult =
  | { ok: true; payload: MagicLinkPayload }
  | { ok: false; reason: VerifyFailure };

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlToBytes(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

/** HMAC-SHA256 a string, base64url-encoded. Shared by tokens and cookies. */
export async function hmacSign(message: string, secret: string): Promise<string> {
  const signature = await crypto.subtle.sign(
    "HMAC",
    await hmacKey(secret),
    encoder.encode(message),
  );
  return bytesToBase64Url(new Uint8Array(signature));
}

/** Constant-time verification via WebCrypto (never a string `===` on a MAC). */
export async function hmacVerify(
  message: string,
  signature: string,
  secret: string,
): Promise<boolean> {
  let bytes: Uint8Array;
  try {
    bytes = base64UrlToBytes(signature);
  } catch {
    return false;
  }
  return crypto.subtle.verify(
    "HMAC",
    await hmacKey(secret),
    bytes as unknown as ArrayBuffer,
    encoder.encode(message),
  );
}

export async function signMagicLink(
  payload: MagicLinkPayload,
  secret: string,
): Promise<string> {
  const body = bytesToBase64Url(encoder.encode(JSON.stringify(payload)));
  const signature = await hmacSign(body, secret);
  return `${body}.${signature}`;
}

export async function verifyMagicLink(
  token: string,
  secret: string,
  now: number = Date.now(),
): Promise<VerifyResult> {
  const parts = token.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    return { ok: false, reason: "malformed" };
  }
  const [body, signature] = parts;

  if (!(await hmacVerify(body, signature, secret))) {
    return { ok: false, reason: "bad_signature" };
  }

  let payload: MagicLinkPayload;
  try {
    payload = JSON.parse(decoder.decode(base64UrlToBytes(body))) as MagicLinkPayload;
  } catch {
    return { ok: false, reason: "malformed" };
  }

  if (
    typeof payload?.jti !== "string" ||
    typeof payload?.sub !== "string" ||
    typeof payload?.exp !== "number"
  ) {
    return { ok: false, reason: "malformed" };
  }

  if (payload.exp <= now) return { ok: false, reason: "expired" };

  return { ok: true, payload };
}

/** SHA-256 hex. What gets stored in `auth_tokens.token_hash` — never the token. */
export async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(token));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/** Build the clickable URL for an issued token. */
export function magicLinkUrl(origin: string, token: string, redirectTo?: string): string {
  const url = new URL("/auth/verify", origin);
  url.searchParams.set("token", token);
  if (redirectTo) url.searchParams.set("redirectTo", redirectTo);
  return url.toString();
}
