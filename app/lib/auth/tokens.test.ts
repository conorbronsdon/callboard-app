import { describe, expect, it } from "vitest";

import {
  MAGIC_LINK_TTL_MS,
  hashToken,
  magicLinkUrl,
  signMagicLink,
  verifyMagicLink,
} from "./tokens";

const SECRET = "test-secret-do-not-use-in-prod";
const OTHER_SECRET = "a-completely-different-secret";
const NOW = 1_754_600_000_000;

function payload(overrides: Partial<Parameters<typeof signMagicLink>[0]> = {}) {
  return {
    jti: "3f1c1a1e-0000-4000-8000-000000000001",
    sub: "9a2b3c4d-0000-4000-8000-000000000002",
    exp: NOW + MAGIC_LINK_TTL_MS,
    ...overrides,
  };
}

describe("magic-link tokens", () => {
  it("round-trips a signed token (must fire)", async () => {
    const token = await signMagicLink(payload(), SECRET);
    const result = await verifyMagicLink(token, SECRET, NOW);

    expect(result.ok).toBe(true);
    // Narrow, then assert the actual values — not just the shape.
    if (!result.ok) throw new Error("expected verification to succeed");
    expect(result.payload.jti).toBe("3f1c1a1e-0000-4000-8000-000000000001");
    expect(result.payload.sub).toBe("9a2b3c4d-0000-4000-8000-000000000002");
    expect(result.payload.exp).toBe(NOW + MAGIC_LINK_TTL_MS);
  });

  it("rejects a token signed with a different secret (must NOT fire)", async () => {
    const token = await signMagicLink(payload(), OTHER_SECRET);
    const result = await verifyMagicLink(token, SECRET, NOW);

    expect(result).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("rejects a tampered payload (must NOT fire)", async () => {
    const token = await signMagicLink(payload(), SECRET);
    const [body, signature] = token.split(".");
    // Flip the first character of the payload, keeping the original signature.
    const flipped = (body[0] === "e" ? "f" : "e") + body.slice(1);
    const result = await verifyMagicLink(`${flipped}.${signature}`, SECRET, NOW);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected verification to fail");
    expect(["bad_signature", "malformed"]).toContain(result.reason);
  });

  it("rejects an expired token (must NOT fire)", async () => {
    const token = await signMagicLink(payload({ exp: NOW - 1 }), SECRET);
    const result = await verifyMagicLink(token, SECRET, NOW);

    expect(result).toEqual({ ok: false, reason: "expired" });
  });

  it("accepts a token one millisecond before expiry, rejects it one after", async () => {
    const exp = NOW + 1;
    const token = await signMagicLink(payload({ exp }), SECRET);

    expect((await verifyMagicLink(token, SECRET, NOW)).ok).toBe(true);
    expect((await verifyMagicLink(token, SECRET, exp)).ok).toBe(false);
  });

  it("rejects structurally malformed input (must NOT fire)", async () => {
    for (const bad of ["", "nodot", "a.b.c", ".sig", "body."]) {
      const result = await verifyMagicLink(bad, SECRET, NOW);
      expect(result.ok, `expected "${bad}" to be rejected`).toBe(false);
    }
  });

  it("verifies the same token more than once inside the TTL (email prefetchers)", async () => {
    const token = await signMagicLink(payload(), SECRET);

    expect((await verifyMagicLink(token, SECRET, NOW)).ok).toBe(true);
    expect((await verifyMagicLink(token, SECRET, NOW + 1000)).ok).toBe(true);
  });
});

describe("hashToken", () => {
  it("produces a stable 64-char hex digest", async () => {
    const hash = await hashToken("abc");
    expect(hash).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });

  it("produces different digests for different tokens", async () => {
    expect(await hashToken("abc")).not.toBe(await hashToken("abd"));
  });
});

describe("magicLinkUrl", () => {
  it("builds an absolute verify URL carrying the token and redirect", () => {
    const url = magicLinkUrl("https://callboard.example", "tok.sig", "/portal/tasks");
    expect(url).toBe(
      "https://callboard.example/auth/verify?token=tok.sig&redirectTo=%2Fportal%2Ftasks",
    );
  });

  it("omits redirectTo when not supplied", () => {
    expect(magicLinkUrl("https://callboard.example", "tok.sig")).toBe(
      "https://callboard.example/auth/verify?token=tok.sig",
    );
  });
});
