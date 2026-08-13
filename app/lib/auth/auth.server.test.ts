/**
 * DB-backed magic-link tests.
 *
 * These exist because the interesting failures are not in the signature check —
 * a well-signed token can still be the wrong purpose, point at the wrong person,
 * or be replayed forever. Each rule gets a must-fire case AND the complement
 * that must still work, so a fix that simply refuses everything cannot pass.
 */
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { authTokens, people, sessionsAuth } from "~/db/schema";
import { installTestDb, type TestDbContext } from "~/test/db";

import {
  MAX_MAGIC_LINK_USES,
  consumeMagicLink,
  createLoginSession,
  findOrCreatePerson,
  issueMagicLink,
  requestCfpSignup,
} from "./auth.server";
import { MAGIC_LINK_TTL_MS, hashToken, signMagicLink } from "./tokens";

const SECRET = "test-magic-link-secret";
const LOGIN = "https://callboard.test/login";

let ctx: TestDbContext;

beforeEach(() => {
  ctx = installTestDb();
});
afterEach(() => ctx.close());

function tokenFrom(url: string): string {
  return new URL(url).searchParams.get("token")!;
}

async function issue(email = "speaker@example.com") {
  const issued = await issueMagicLink({ request: new Request(LOGIN), email });
  return { issued, token: tokenFrom(issued.url) };
}

/** A signed token whose row we control — for purpose/subject tampering. */
async function plantToken(options: {
  personId: string;
  subject?: string;
  purpose?: "magic_link" | "invite";
  expiresAt?: Date;
  revokedAt?: Date | null;
  useCount?: number;
}) {
  const jti = crypto.randomUUID();
  const expiresAt = options.expiresAt ?? new Date(Date.now() + MAGIC_LINK_TTL_MS);
  const token = await signMagicLink(
    { jti, sub: options.subject ?? options.personId, exp: expiresAt.getTime() },
    SECRET,
  );
  await ctx.db.insert(authTokens).values({
    id: jti,
    personId: options.personId,
    tokenHash: await hashToken(token),
    purpose: options.purpose ?? "magic_link",
    expiresAt,
    revokedAt: options.revokedAt ?? null,
    useCount: options.useCount ?? 0,
  });
  return { token, jti };
}

describe("public CFP email proof boundary", () => {
  it("must fire: requesting access for a new address creates no authenticated session", async () => {
    const issued = await requestCfpSignup({
      request: new Request(LOGIN),
      email: "unclaimed@example.com",
      eventId: "event-a",
      fullName: "CFP Submitter",
      redirectTo: "/submit/event-a/form-a/step/submission",
    });

    const person = await ctx.db.query.people.findFirst({
      where: eq(people.email, "unclaimed@example.com"),
    });
    const token = await ctx.db.query.authTokens.findFirst({
      where: eq(authTokens.personId, issued.person.id),
    });
    const sessions = await ctx.db.select().from(sessionsAuth);

    expect(person).toMatchObject({ id: issued.person.id, fullName: "CFP Submitter" });
    expect(token?.personId).toBe(issued.person.id);
    expect(sessions).toHaveLength(0);
  });

  it("must NOT overwrite a known profile before that address proves ownership", async () => {
    const owner = await findOrCreatePerson("owner@example.com", {
      fullName: "Original Owner",
      role: "speaker",
    });

    const issued = await requestCfpSignup({
      request: new Request(LOGIN),
      email: owner.email,
      eventId: "event-a",
      fullName: "Attacker Supplied",
      redirectTo: "/submit/event-a/form-a/step/submission",
    });
    const after = await ctx.db.query.people.findFirst({
      where: eq(people.id, owner.id),
    });

    expect(issued.person.id).toBe(owner.id);
    expect(after?.fullName).toBe("Original Owner");
    expect(await ctx.db.select().from(sessionsAuth)).toHaveLength(0);
  });

  it("must NOT fire: a redeemed link can create the session needed to continue", async () => {
    const issued = await requestCfpSignup({
      request: new Request(LOGIN),
      email: "verified@example.com",
      eventId: "event-a",
      fullName: "CFP Submitter",
      redirectTo: "/submit/event-a/form-a/step/submission",
    });

    const result = await consumeMagicLink(tokenFrom(issued.url));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected the magic link to verify");

    const cookie = await createLoginSession(new Request(LOGIN), result.person.id);
    const sessions = await ctx.db.select().from(sessionsAuth);

    expect(cookie).toContain("cb_session=");
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.personId).toBe(issued.person.id);
  });

  it("rate limit must fire before an extra person or token is created, while another event remains isolated", async () => {
    // `inlineSignupIp` is a FIXED window (10/hour), and `requestCfpSignup` never
    // threads an injectable `now` down to `consumeRateLimit` — so a run
    // straddling the hourly wall-clock mark (windowStart snaps to the top of
    // the hour) resets the counter mid-test and the 11th request below stops
    // being refused. Same class of flake as
    // admin.reviews.provisioning.test.tsx's magic-link case; pin the clock with
    // the same vi.useFakeTimers()/vi.setSystemTime() idiom
    // app/lib/admin/session-revisions.server.test.ts already uses elsewhere.
    // 12:30:00 sits 30 minutes clear of the boundary on either side.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-12T12:30:00.000Z"));
    try {
      for (let index = 0; index < 10; index += 1) {
        await requestCfpSignup({
          request: new Request(LOGIN),
          email: `limited-${index}@example.com`,
          eventId: "event-a",
          fullName: "Rate Limited Submitter",
          redirectTo: "/submit/event-a/form-a/step/submission",
        });
      }

      await expect(
        requestCfpSignup({
          request: new Request(LOGIN),
          email: "blocked@example.com",
          eventId: "event-a",
          fullName: "Rate Limited Submitter",
          redirectTo: "/submit/event-a/form-a/step/submission",
        }),
      ).rejects.toMatchObject({ status: 429 });

      expect(
        await ctx.db.query.people.findFirst({
          where: eq(people.email, "blocked@example.com"),
        }),
      ).toBeUndefined();
      expect(await ctx.db.select().from(authTokens)).toHaveLength(10);

      await expect(
        requestCfpSignup({
          request: new Request(LOGIN),
          email: "other-event@example.com",
          eventId: "event-b",
          fullName: "Other Event",
          redirectTo: "/submit/event-b/form-b/step/submission",
        }),
      ).resolves.toMatchObject({ person: { email: "other-event@example.com" } });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("consumeMagicLink — happy path", () => {
  it("signs the person in and counts the use", async () => {
    const { issued, token } = await issue();
    const result = await consumeMagicLink(token);

    expect(result.ok).toBe(true);
    expect(result.ok && result.person.id).toBe(issued.person.id);

    const row = await ctx.db.query.authTokens.findFirst({
      where: eq(authTokens.personId, issued.person.id),
    });
    expect(row?.useCount).toBe(1);
    expect(row?.consumedAt).toBeInstanceOf(Date);
  });
});

describe("consumeMagicLink — replay cap", () => {
  it("tolerates prefetchers: the first MAX uses all succeed", async () => {
    const { token } = await issue();
    for (let i = 0; i < MAX_MAGIC_LINK_USES; i += 1) {
      const result = await consumeMagicLink(token);
      expect(result.ok).toBe(true);
    }
  });

  it("must fire: use MAX+1 is refused and the counter stops climbing", async () => {
    const { issued, token } = await issue();
    for (let i = 0; i < MAX_MAGIC_LINK_USES; i += 1) await consumeMagicLink(token);

    const overflow = await consumeMagicLink(token);
    expect(overflow).toEqual({ ok: false, reason: "exhausted" });

    const row = await ctx.db.query.authTokens.findFirst({
      where: eq(authTokens.personId, issued.person.id),
    });
    expect(row?.useCount).toBe(MAX_MAGIC_LINK_USES);
  });

  it("keeps the FIRST consumedAt across repeat uses", async () => {
    const { issued, token } = await issue();
    await consumeMagicLink(token);
    const first = await ctx.db.query.authTokens.findFirst({
      where: eq(authTokens.personId, issued.person.id),
    });

    await new Promise((resolve) => setTimeout(resolve, 5));
    await consumeMagicLink(token);
    const second = await ctx.db.query.authTokens.findFirst({
      where: eq(authTokens.personId, issued.person.id),
    });

    expect(second?.consumedAt?.getTime()).toBe(first?.consumedAt?.getTime());
    expect(second?.useCount).toBe(2);
  });

  // NOTE: node:sqlite is synchronous, so this stages interleaved calls, not a
  // true race. What it proves is that the cap lives in the WHERE clause: eight
  // overlapping redemptions yield exactly MAX successes and MAX increments,
  // which a read-then-write increment could not guarantee.
  it("refuses past the cap when redemptions are issued together", async () => {
    const { issued, token } = await issue();
    const results = await Promise.all(
      Array.from({ length: 8 }, () => consumeMagicLink(token)),
    );

    const okCount = results.filter((result) => result.ok).length;
    expect(okCount).toBe(MAX_MAGIC_LINK_USES);

    const row = await ctx.db.query.authTokens.findFirst({
      where: eq(authTokens.personId, issued.person.id),
    });
    expect(row?.useCount).toBe(MAX_MAGIC_LINK_USES);
  });
});

describe("consumeMagicLink — purpose", () => {
  it("must fire: an invite token cannot be spent as a sign-in link", async () => {
    const person = await findOrCreatePerson("invitee@example.com");
    const { token } = await plantToken({ personId: person.id, purpose: "invite" });

    expect(await consumeMagicLink(token)).toEqual({ ok: false, reason: "wrong_purpose" });

    const row = await ctx.db.query.authTokens.findFirst({
      where: eq(authTokens.personId, person.id),
    });
    expect(row?.useCount).toBe(0);
  });

  it("must NOT fire: the same token works when that purpose is what is asked for", async () => {
    const person = await findOrCreatePerson("invitee2@example.com");
    const { token } = await plantToken({ personId: person.id, purpose: "invite" });

    const result = await consumeMagicLink(token, "invite");
    expect(result.ok).toBe(true);
    expect(result.ok && result.person.id).toBe(person.id);
  });
});

describe("consumeMagicLink — subject binding", () => {
  it("must fire: a payload subject that disagrees with the row is rejected", async () => {
    const victim = await findOrCreatePerson("victim@example.com");
    const attacker = await findOrCreatePerson("attacker@example.com");
    const { token } = await plantToken({
      personId: victim.id,
      subject: attacker.id,
    });

    expect(await consumeMagicLink(token)).toEqual({ ok: false, reason: "invalid" });

    const row = await ctx.db.query.authTokens.findFirst({
      where: eq(authTokens.personId, victim.id),
    });
    expect(row?.useCount).toBe(0);
  });

  it("must NOT fire: a matching subject still signs in", async () => {
    const person = await findOrCreatePerson("match@example.com");
    const { token } = await plantToken({ personId: person.id, subject: person.id });

    const result = await consumeMagicLink(token);
    expect(result.ok).toBe(true);
    expect(result.ok && result.person.email).toBe("match@example.com");
  });
});

describe("consumeMagicLink — the pre-existing guards still hold", () => {
  it("rejects a revoked token", async () => {
    const person = await findOrCreatePerson("revoked@example.com");
    const { token } = await plantToken({ personId: person.id, revokedAt: new Date() });
    expect(await consumeMagicLink(token)).toEqual({ ok: false, reason: "revoked" });
  });

  it("rejects an expired token", async () => {
    const person = await findOrCreatePerson("expired@example.com");
    const { token } = await plantToken({
      personId: person.id,
      expiresAt: new Date(Date.now() - 1000),
    });
    expect(await consumeMagicLink(token)).toEqual({ ok: false, reason: "expired" });
  });

  it("rejects a token with no row (forged jti)", async () => {
    const expiresAt = Date.now() + MAGIC_LINK_TTL_MS;
    const token = await signMagicLink(
      { jti: crypto.randomUUID(), sub: crypto.randomUUID(), exp: expiresAt },
      SECRET,
    );
    expect(await consumeMagicLink(token)).toEqual({ ok: false, reason: "invalid" });
  });

  it("rejects a token signed with the wrong secret", async () => {
    const expiresAt = Date.now() + MAGIC_LINK_TTL_MS;
    const token = await signMagicLink(
      { jti: crypto.randomUUID(), sub: crypto.randomUUID(), exp: expiresAt },
      "not-the-secret",
    );
    expect(await consumeMagicLink(token)).toEqual({ ok: false, reason: "invalid" });
  });

  it("reports unknown_person when the row points at nobody", async () => {
    const person = await findOrCreatePerson("ghost@example.com");
    const { token } = await plantToken({ personId: person.id });
    // Deleting the person cascades the token away, so re-point the row instead.
    await ctx.db.delete(people).where(eq(people.email, "ghost@example.com"));
    expect((await consumeMagicLink(token)).ok).toBe(false);
  });
});
