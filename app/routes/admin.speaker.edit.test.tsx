import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { eventPeople, people } from "~/db/schema";
import { listComms } from "~/lib/comms/comm-log.server";
import { signedInPost } from "~/test/auth";
import { installTestDb, type TestDbContext } from "~/test/db";
import { seedDemoFixture, type DemoFixture } from "~/test/fixtures";

import { action, loader } from "./admin.speaker";

type ActionArgs = Parameters<typeof action>[0];
type LoaderArgs = Parameters<typeof loader>[0];

let ctx: TestDbContext;
let fixture: DemoFixture;

beforeEach(async () => {
  ctx = installTestDb();
  fixture = await seedDemoFixture(ctx.db);
});
afterEach(() => ctx.close());

async function edit(id: string, fields: Record<string, string>) {
  return action({
    request: await signedInPost(`https://x.test/admin/speakers/${id}`, fixture.adminId, {
      intent: "edit-speaker",
      ...fields,
    }),
    params: { id },
    context: {},
  } as unknown as ActionArgs);
}

describe("organizer speaker editing", () => {
  it("persists all editable profile fields through a reload", async () => {
    const id = fixture.speakerIds[0];
    const result = await edit(id, {
      fullName: "Sam Updated",
      title: "Principal Engineer",
      company: "Updated Company",
      pronouns: "they/them",
      bio: "SBEK-ORG-EDIT-01",
    });

    expect(result).toEqual({ ok: true, notice: "Speaker details saved." });
    const request = await import("~/test/auth").then(({ signedInGet }) =>
      signedInGet(`https://x.test/admin/speakers/${id}`, fixture.adminId),
    );
    const reloaded = await loader({ request, params: { id }, context: {} } as unknown as LoaderArgs);
    expect(reloaded.speaker).toMatchObject({
      name: "Sam Updated",
      title: "Principal Engineer",
      company: "Updated Company",
      pronouns: "they/them",
      bio: "SBEK-ORG-EDIT-01",
    });
  });

  it("rejects a person outside the current event and writes nothing", async () => {
    await ctx.db.insert(people).values({
      id: "outside-person",
      email: "outside@example.com",
      fullName: "Outside Person",
      bio: "Original",
      role: "speaker",
    });

    expect(await edit("outside-person", { fullName: "Changed", bio: "Changed" })).toEqual({
      ok: false,
      error: "That person is not on this event's roster.",
    });
    expect(await ctx.db.query.people.findFirst({ where: eq(people.id, "outside-person") })).toMatchObject({
      fullName: "Outside Person",
      bio: "Original",
    });
    expect(
      await ctx.db.query.eventPeople.findFirst({
        where: and(
          eq(eventPeople.eventId, fixture.eventId),
          eq(eventPeople.personId, "outside-person"),
        ),
      }),
    ).toBeUndefined();
  });

  it("rejects an over-length bio and preserves the old value", async () => {
    const id = fixture.speakerIds[0];
    const before = await ctx.db.query.people.findFirst({ where: eq(people.id, id) });

    const result = await edit(id, {
      fullName: "Should Not Save",
      bio: "x".repeat(5001),
    });

    expect(result).toMatchObject({ ok: false });
    expect((result as { error: string }).error).toContain("5001 characters");
    expect(await ctx.db.query.people.findFirst({ where: eq(people.id, id) })).toMatchObject({
      fullName: before!.fullName,
      bio: before!.bio,
    });
  });
});

describe("send-invite from the speaker detail page (SPK-06)", () => {
  it("MUST FIRE: logs a comm_log row with the portal_invite template", async () => {
    const id = fixture.speakerIds[0];
    const result = await action({
      request: await signedInPost(`https://x.test/admin/speakers/${id}`, fixture.adminId, {
        intent: "send-invite",
      }),
      params: { id },
      context: {},
    } as unknown as ActionArgs);

    expect(result).toMatchObject({ ok: true });
    expect((result as { notice: string }).notice).toMatch(/portal invite sent/i);

    const rows = await listComms({ eventId: fixture.eventId, personId: id, db: ctx.db });
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows[0].templateKey).toBe("portal_invite");
  });

  it("MUST NOT FIRE: a person who is not on this event's roster", async () => {
    await ctx.db.insert(people).values({
      id: "outside-invite",
      email: "outside-invite@example.com",
      fullName: "Outside Invite",
      role: "speaker",
    });

    const result = await action({
      request: await signedInPost(
        "https://x.test/admin/speakers/outside-invite",
        fixture.adminId,
        { intent: "send-invite" },
      ),
      params: { id: "outside-invite" },
      context: {},
    } as unknown as ActionArgs);

    expect(result).toEqual({ ok: false, error: "That person is not on this event's roster." });
    expect(
      await listComms({ eventId: fixture.eventId, personId: "outside-invite", db: ctx.db }),
    ).toEqual([]);
  });
});
