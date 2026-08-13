/**
 * `POST /api/upload` — which event does the stored file bind to?
 *
 * This route lives outside `/admin`, so it never sees the organizer's event
 * selection cookie and `requireCurrentEvent` always resolves the DEFAULT event
 * here. That is correct for a person upload and wrong for a session upload:
 * sessions are event-owned, so binding a second-event session's file to the
 * default event 403s a speaker who genuinely presents at it, and any row that
 * did get written would carry the wrong `event_id`.
 *
 * Every case below is paired. "A speaker can upload to their event-2 session"
 * proves nothing on its own — a route that skipped `mayAttachTo` entirely would
 * pass it — so each must-fire sits next to the must-not-fire that such a route
 * would break, and every success also asserts the STORED ROW's `event_id`
 * rather than just a 200.
 */
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { people, sessionParticipants, sessions, uploads } from "~/db/schema";
import { createLoginSession } from "~/lib/auth/auth.server";
import { installTestDb, type TestDbContext } from "~/test/db";
import { env } from "~/test/workers-env";
import {
  seedDemoFixture,
  seedOtherEvent,
  type DemoFixture,
  type OtherEventFixture,
} from "~/test/fixtures";

import { action } from "./api.upload";

type ActionArgs = Parameters<typeof action>[0];
const args = (request: Request) => ({ request, params: {}, context: {} }) as unknown as ActionArgs;

/** Minimal in-memory R2 stand-in; the route only ever `put`s and `delete`s. */
function createTestBucket() {
  const objects = new Map<string, { contentType: string }>();
  return {
    objects,
    binding: {
      async put(key: string, _body: unknown, options?: { httpMetadata?: { contentType?: string } }) {
        objects.set(key, { contentType: options?.httpMetadata?.contentType ?? "" });
      },
      async get(key: string) {
        return objects.has(key) ? ({} as unknown) : null;
      },
      async delete(key: string) {
        objects.delete(key);
      },
    },
  };
}

let ctx: TestDbContext;
let fixture: DemoFixture;
let other: OtherEventFixture;
let bucket: ReturnType<typeof createTestBucket>;

/** A person on neither session — the IDOR this route exists to prevent. */
const OUTSIDER_ID = "13000000-0000-4000-8000-000000000001";

beforeEach(async () => {
  ctx = installTestDb();
  bucket = createTestBucket();
  env.FILES = bucket.binding;
  fixture = await seedDemoFixture(ctx.db);
  other = await seedOtherEvent(ctx.db);
  await ctx.db.insert(people).values({
    id: OUTSIDER_ID,
    email: "outsider@example.com",
    fullName: "Otto Outsider",
    role: "speaker",
  });
});
afterEach(() => ctx.close());

/**
 * A signed-in multipart POST. `text/plain` with ASCII bytes satisfies both the
 * MIME allowlist and the content-signature check, so the request reaches the
 * event-binding logic this file is about rather than dying in validation.
 */
async function upload(
  personId: string,
  fields: { ownerType: "person" | "session"; ownerId: string; purpose?: string },
  query = "",
): Promise<Response> {
  const url = `https://x.test/api/upload${query}`;
  const cookie = (await createLoginSession(new Request(url), personId)).split(";")[0];

  const form = new FormData();
  form.append("file", new File(["speaker notes for the run of show"], "notes.txt", {
    type: "text/plain",
  }));
  form.append("ownerType", fields.ownerType);
  form.append("ownerId", fields.ownerId);
  form.append("purpose", fields.purpose ?? "document");

  return (await action(args(new Request(url, { method: "POST", headers: { cookie }, body: form })))) as Response;
}

async function storedRow(uploadId: string) {
  return ctx.db.query.uploads.findFirst({ where: eq(uploads.id, uploadId) });
}

describe("a session upload binds to the SESSION's event, not the request's", () => {
  it("must fire: a participating speaker uploads to a second-event session", async () => {
    // No cookie, no ?event= — `requireCurrentEvent` resolves the default event,
    // which is NOT the event this session belongs to. Pre-fix this was a 403.
    const response = await upload(other.speakerId, {
      ownerType: "session",
      ownerId: other.programSessionId,
    });
    expect(response.status).toBe(200);

    const body = (await response.json()) as { ok: boolean; upload: { id: string } };
    expect(body.ok).toBe(true);

    const row = await storedRow(body.upload.id);
    // Provenance, asserted by value in both directions.
    expect(row?.eventId).toBe(other.eventId);
    expect(row?.eventId).not.toBe(fixture.eventId);
    expect(row?.ownerType).toBe("session");
    expect(row?.ownerId).toBe(other.programSessionId);
    // The R2 key is event-scoped too, so the bucket layout matches the row.
    expect(row?.key.startsWith(`${other.eventId}/session/`)).toBe(true);
    expect(bucket.objects.has(row!.key)).toBe(true);
  });

  it("must fire: an admin with no selection uploads to a second-event session", async () => {
    const response = await upload(fixture.adminId, {
      ownerType: "session",
      ownerId: other.abstractIds[0],
    });
    expect(response.status).toBe(200);

    const body = (await response.json()) as { upload: { id: string } };
    const row = await storedRow(body.upload.id);
    expect(row?.eventId).toBe(other.eventId);
    expect(row?.uploadedById).toBe(fixture.adminId);
  });

  it("must fire: the primary event still works, and still stamps ITS id", async () => {
    // The control for the case above — if the fix had simply stopped scoping,
    // this row could land on the wrong event too and nobody would notice.
    const response = await upload(fixture.speakerIds[0], {
      ownerType: "session",
      ownerId: fixture.programSessionIds[0],
      purpose: "slides",
    });
    expect(response.status).toBe(200);

    const body = (await response.json()) as { upload: { id: string } };
    const row = await storedRow(body.upload.id);
    expect(row?.eventId).toBe(fixture.eventId);
    expect(row?.eventId).not.toBe(other.eventId);
  });

  it("must NOT fire: a non-participant still cannot attach to a second-event session", async () => {
    const response = await upload(OUTSIDER_ID, {
      ownerType: "session",
      ownerId: other.programSessionId,
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      ok: false,
      error: "You cannot attach a file to that record.",
    });
    // Nothing was written to R2 or to the table.
    expect(bucket.objects.size).toBe(0);
    expect(await ctx.db.select().from(uploads)).toHaveLength(0);
  });

  it("must NOT fire: a speaker cannot attach to a session on the OTHER event they are not on", async () => {
    // The second event's speaker is a real speaker — just not on this session.
    const response = await upload(other.speakerId, {
      ownerType: "session",
      ownerId: fixture.programSessionIds[0],
    });
    expect(response.status).toBe(403);
    expect(await ctx.db.select().from(uploads)).toHaveLength(0);
  });

  it("must NOT fire: a bogus session id 403s opaquely, with the same body as a denial", async () => {
    const bogus = await upload(fixture.adminId, {
      ownerType: "session",
      ownerId: "00000000-0000-4000-8000-000000000999",
    });
    const denied = await upload(OUTSIDER_ID, {
      ownerType: "session",
      ownerId: other.programSessionId,
    });

    expect(bogus.status).toBe(403);
    // Identical status AND body: a distinct 404 would confirm which ids exist.
    expect(bogus.status).toBe(denied.status);
    expect(await bogus.json()).toEqual(await denied.json());
    expect(await ctx.db.select().from(uploads)).toHaveLength(0);
  });

  it("must NOT fire: a DELETED session's id behaves like any other unknown id", async () => {
    // Must fire first, so the 403 below is caused by the deletion and not by
    // the id having been unusable all along.
    const before = await upload(other.speakerId, {
      ownerType: "session",
      ownerId: other.abstractIds[1],
    });
    expect(before.status).toBe(200);

    await ctx.db.delete(uploads);
    await ctx.db
      .delete(sessionParticipants)
      .where(eq(sessionParticipants.sessionId, other.abstractIds[1]));
    await ctx.db.delete(sessions).where(eq(sessions.id, other.abstractIds[1]));

    const after = await upload(other.speakerId, {
      ownerType: "session",
      ownerId: other.abstractIds[1],
    });
    expect(after.status).toBe(403);
  });
});

/**
 * The limiter runs BEFORE the multipart parse, so it cannot know the target's
 * event — which is exactly why its scope must not be derived from the request's
 * `?event=` either. `currentEvent` honours the param on every path, and in
 * `rate-limit.server.ts` the scope is both part of the `(scope,
 * identifier_hash, window_start)` primary key AND HMAC'd into the digest, so a
 * different scope string is a whole fresh bucket. One selectable bucket per
 * event multiplies the allowance by the event count.
 *
 * Asserted against the STORED rows rather than by exhausting 30 uploads: the
 * row count IS the bucket count, and it is the thing the cap is applied per.
 */
describe("the upload rate-limit bucket is not caller-selectable", () => {
  const buckets = () =>
    ctx.sqlite
      .prepare("select scope, window_count from rate_limit_windows order by scope")
      .all() as { scope: string; window_count: number }[];

  it("must fire: one person switching ?event= keeps ONE bucket", async () => {
    expect((await upload(fixture.adminId, { ownerType: "person", ownerId: fixture.adminId })).status).toBe(200);
    expect(
      (
        await upload(
          fixture.adminId,
          { ownerType: "person", ownerId: fixture.adminId },
          `?event=${other.slug}`,
        )
      ).status,
    ).toBe(200);

    const rows = buckets();
    expect(rows).toHaveLength(1);
    // Both requests counted against the same window — the budget is shared.
    expect(rows[0].window_count).toBe(2);
    // And the key the cap hangs on carries no caller-supplied event.
    expect(rows[0].scope).not.toContain(fixture.eventId);
    expect(rows[0].scope).not.toContain(other.eventId);
  });

  it("must NOT fire: two different people still get their own budgets", async () => {
    // The control. A limiter that collapsed every caller into one bucket would
    // pass the test above and let one speaker exhaust everybody's allowance.
    expect((await upload(fixture.speakerIds[0], { ownerType: "person", ownerId: fixture.speakerIds[0] })).status).toBe(200);
    expect((await upload(other.speakerId, { ownerType: "person", ownerId: other.speakerId })).status).toBe(200);

    const rows = buckets();
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.window_count)).toEqual([1, 1]);
  });
});

describe("a person upload is unchanged", () => {
  it("still binds to the REQUEST's event, not to anything target-derived", async () => {
    const response = await upload(fixture.speakerIds[0], {
      ownerType: "person",
      ownerId: fixture.speakerIds[0],
      purpose: "document",
    });
    expect(response.status).toBe(200);

    const body = (await response.json()) as { upload: { id: string } };
    const row = await storedRow(body.upload.id);
    // People are deployment-global; the event here is quota/context attribution
    // and stays whatever `requireCurrentEvent` resolved — the default event.
    expect(row?.eventId).toBe(fixture.eventId);
    expect(row?.ownerType).toBe("person");
  });

  it("still follows an explicit ?event=, which is the only lever this route had", async () => {
    const response = await upload(
      other.speakerId,
      { ownerType: "person", ownerId: other.speakerId },
      `?event=${other.slug}`,
    );
    expect(response.status).toBe(200);

    const body = (await response.json()) as { upload: { id: string } };
    expect((await storedRow(body.upload.id))?.eventId).toBe(other.eventId);
  });

  it("must NOT fire: a speaker still cannot upload onto somebody else's person record", async () => {
    const response = await upload(fixture.speakerIds[0], {
      ownerType: "person",
      ownerId: OUTSIDER_ID,
    });
    expect(response.status).toBe(403);
    expect(await ctx.db.select().from(uploads)).toHaveLength(0);
  });

  it("must NOT fire: an admin still cannot upload onto a person id that does not exist", async () => {
    const response = await upload(fixture.adminId, {
      ownerType: "person",
      ownerId: "00000000-0000-4000-8000-000000000998",
    });
    expect(response.status).toBe(403);
    expect(bucket.objects.size).toBe(0);
  });
});
