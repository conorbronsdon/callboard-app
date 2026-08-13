import { renderToStaticMarkup } from "react-dom/server";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { eventPeople, events, people } from "~/db/schema";
import { listComms } from "~/lib/comms/comm-log.server";
import { signedInGet, signedInPost } from "~/test/auth";
import { installTestDb, type TestDbContext } from "~/test/db";
import {
  EVENT_ID,
  OTHER_EVENT_SLUG,
  seedDemoFixture,
  seedOtherEvent,
  type DemoFixture,
} from "~/test/fixtures";

import AdminSpeakers, { action, loader } from "./admin.speakers";

type ActionArgs = Parameters<typeof action>[0];
type LoaderArgs = Parameters<typeof loader>[0];

let ctx: TestDbContext;
let fixture: DemoFixture;

beforeEach(async () => {
  ctx = installTestDb();
  fixture = await seedDemoFixture(ctx.db);
});
afterEach(() => ctx.close());

async function load(url = "https://x.test/admin/speakers") {
  return loader({
    request: await signedInGet(url, fixture.adminId),
    params: {},
    context: {},
  } as unknown as LoaderArgs);
}

async function post(fields: Record<string, string>, url = "https://x.test/admin/speakers") {
  return action({
    request: await signedInPost(url, fixture.adminId, fields),
    params: {},
    context: {},
  } as unknown as ActionArgs);
}

/** Like `post`, but for repeated keys (bulk `personId` checkboxes). */
async function postMulti(pairs: [string, string][], url = "https://x.test/admin/speakers") {
  const cookie = (await signedInGet(url, fixture.adminId)).headers.get("cookie") ?? "";
  const request = new Request(url, {
    method: "POST",
    headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(pairs).toString(),
  });
  return action({ request, params: {}, context: {} } as unknown as ActionArgs);
}

function render(data: Awaited<ReturnType<typeof loader>>) {
  const props = { loaderData: data } as unknown as Parameters<typeof AdminSpeakers>[0];
  return renderToStaticMarkup(<AdminSpeakers {...props} />);
}

describe("roster loader and render", () => {
  it("renders seeded rows with their persisted status badges", async () => {
    await ctx.db
      .update(eventPeople)
      .set({ status: "confirmed" })
      .where(and(eq(eventPeople.eventId, EVENT_ID), eq(eventPeople.personId, fixture.speakerIds[0])));

    const data = await load();
    const html = render(data);

    expect(data.speakers.find((row) => row.id === fixture.speakerIds[0])?.status).toBe(
      "confirmed",
    );
    expect(html).toContain("Sam Speaker");
    expect(html).toContain("Confirmed");
    expect(html).toContain("speaker-roster");
  });

  it("renders a true zero state for an empty event", async () => {
    await ctx.db.insert(events).values({
      id: "empty-event",
      name: "Empty Event",
      slug: "empty-event",
    });

    const data = await load("https://x.test/admin/speakers?event=empty-event");
    const html = render(data);

    expect(data.speakers).toEqual([]);
    expect(html).toContain("No speakers found");
    expect(html).toContain("Add a speaker or import a CSV");
  });

  it("narrows by case-insensitive search and clearing restores the roster", async () => {
    const narrowed = await load("https://x.test/admin/speakers?q=SAM%20SPEAKER");
    const narrowedHtml = render(narrowed);
    const cleared = await load();
    const clearedHtml = render(cleared);

    expect(narrowed.speakers.map((row) => row.fullName)).toEqual(["Sam Speaker"]);
    expect(narrowedHtml).toContain("Sam Speaker");
    expect(narrowedHtml).not.toContain("Rina Okafor");
    expect(cleared.speakers.length).toBeGreaterThan(narrowed.speakers.length);
    expect(clearedHtml).toContain("Sam Speaker");
    expect(clearedHtml).toContain("Rina Okafor");
  });

  it("treats SQL wildcard characters as literal search text", async () => {
    expect((await load("https://x.test/admin/speakers?q=%25")).speakers).toEqual([]);
    expect((await load("https://x.test/admin/speakers?q=_")).speakers).toEqual([]);
  });
});

describe("manual add and status actions", () => {
  it("creates a normalized portal recipient and event membership", async () => {
    const result = await post({
      intent: "add-speaker",
      fullName: "New Speaker",
      email: "  NEW.SPEAKER@Example.COM  ",
      title: "CTO",
      company: "New Co",
      bio: "A new biography.",
    });

    expect(result).toMatchObject({ ok: true, notice: "Speaker added to this event." });
    const created = await ctx.db.query.people.findFirst({
      where: eq(people.email, "new.speaker@example.com"),
    });
    expect(created).toMatchObject({
      email: "new.speaker@example.com",
      fullName: "New Speaker",
      role: "speaker",
    });
    const membership = await ctx.db.query.eventPeople.findFirst({
      where: and(
        eq(eventPeople.eventId, EVENT_ID),
        eq(eventPeople.personId, created!.id),
      ),
    });
    expect(membership).toMatchObject({ eventRole: "speaker", status: "invited" });
  });

  it("keeps a manually added speaker viable for magic-link delivery", async () => {
    await post({
      intent: "add-speaker",
      fullName: "Portal Recipient",
      email: "  PORTAL.RECIPIENT@Example.COM ",
    });

    const recipient = await ctx.db.query.people.findFirst({
      where: eq(people.email, "portal.recipient@example.com"),
    });
    expect(recipient).toMatchObject({
      email: "portal.recipient@example.com",
      role: "speaker",
    });
    expect(
      await ctx.db.query.eventPeople.findFirst({
        where: and(
          eq(eventPeople.eventId, EVENT_ID),
          eq(eventPeople.personId, recipient!.id),
        ),
      }),
    ).toMatchObject({ eventRole: "speaker" });
  });

  it("attaches an existing person without clobbering their global profile", async () => {
    await ctx.db.insert(people).values({
      id: "global-existing",
      email: "known@example.com",
      fullName: "Known Name",
      title: "Known Title",
      company: "Known Company",
      bio: "Known biography",
      role: "speaker",
    });

    const result = await post({
      intent: "add-speaker",
      email: "KNOWN@example.com",
      fullName: "Overwrite Attempt",
      title: "Wrong Title",
      company: "Wrong Company",
      bio: "Wrong biography",
    });

    expect(result).toMatchObject({
      ok: true,
      notice: "Existing person attached; their global profile was left unchanged.",
    });
    expect(await ctx.db.query.people.findFirst({ where: eq(people.id, "global-existing") })).toMatchObject({
      fullName: "Known Name",
      title: "Known Title",
      company: "Known Company",
      bio: "Known biography",
    });
    expect(
      await ctx.db.query.eventPeople.findFirst({
        where: and(
          eq(eventPeople.eventId, EVENT_ID),
          eq(eventPeople.personId, "global-existing"),
        ),
      }),
    ).toBeDefined();
  });

  it("rejects blank and malformed email without writing", async () => {
    const beforePeople = (await ctx.db.select().from(people)).length;
    const beforeLinks = (await ctx.db.select().from(eventPeople)).length;

    expect(await post({ intent: "add-speaker", email: "   " })).toEqual({
      ok: false,
      error: "Email is required.",
    });
    expect(await post({ intent: "add-speaker", email: "broken@" })).toEqual({
      ok: false,
      error: "Enter a valid email address.",
    });
    expect((await ctx.db.select().from(people)).length).toBe(beforePeople);
    expect((await ctx.db.select().from(eventPeople)).length).toBe(beforeLinks);
  });

  it("persists a valid status and rejects an unknown status", async () => {
    const personId = fixture.speakerIds[0];
    expect(
      await post({ intent: "set-status", personId, status: "ready" }),
    ).toMatchObject({ ok: true });
    expect(
      await ctx.db.query.eventPeople.findFirst({
        where: and(eq(eventPeople.eventId, EVENT_ID), eq(eventPeople.personId, personId)),
      }),
    ).toMatchObject({ status: "ready" });

    expect(await post({ intent: "set-status", personId, status: "scheduled" })).toMatchObject({
      ok: false,
    });
    expect(
      await ctx.db.query.eventPeople.findFirst({
        where: and(eq(eventPeople.eventId, EVENT_ID), eq(eventPeople.personId, personId)),
      }),
    ).toMatchObject({ status: "ready" });
  });

  /*
   * MUST-NOT-FIRE for the success notice. The UPDATE's WHERE already scopes to
   * this event, so the danger is not a cross-event write — it is the screen
   * reporting "updated" for a row that does not exist here. Asserting the error
   * AND that the other event's row is untouched keeps both halves honest.
   */
  it("refuses a status change for someone who is not on this event", async () => {
    const other = await seedOtherEvent(ctx.db);
    const outsiderId = other.speakerId;

    const before = await ctx.db.query.eventPeople.findFirst({
      where: eq(eventPeople.personId, outsiderId),
    });

    expect(await post({ intent: "set-status", personId: outsiderId, status: "ready" })).toEqual({
      ok: false,
      error: "That person is not on this event's roster.",
    });
    expect(
      await ctx.db.query.eventPeople.findFirst({ where: eq(eventPeople.personId, outsiderId) }),
    ).toMatchObject({ status: before?.status ?? "invited" });
  });
});

describe("CSV commit", () => {
  it("creates valid speakers and reports roster duplicates as skipped", async () => {
    const result = await post({
      intent: "import-commit",
      rawCsv:
        "Name,Email,Company,Bio\nSam Duplicate,speaker@callboard.dev,Wrong,Wrong\nCSV New,csv-new@example.com,CSV Co,Imported bio\n",
    });

    expect(result).toMatchObject({
      ok: true,
      notice: "Imported 1 speaker; 1 duplicate skipped.",
    });
    expect(result && "preview" in result ? result.preview?.counts : null).toEqual({
      create: 1,
      duplicate: 1,
      error: 0,
    });
    const created = await ctx.db.query.people.findFirst({
      where: eq(people.email, "csv-new@example.com"),
    });
    expect(created).toMatchObject({ fullName: "CSV New", company: "CSV Co", bio: "Imported bio" });
    expect(
      await ctx.db.query.eventPeople.findFirst({
        where: and(eq(eventPeople.eventId, EVENT_ID), eq(eventPeople.personId, created!.id)),
      }),
    ).toMatchObject({ status: "invited" });
  });

  it("writes zero rows when any re-parsed row is an error", async () => {
    const peopleBefore = (await ctx.db.select().from(people)).length;
    const linksBefore = (await ctx.db.select().from(eventPeople)).length;
    const result = await post({
      intent: "import-commit",
      rawCsv:
        "Name,Email\nWould Otherwise Create,no-write@example.com\nBroken Row,broken@\n",
    });

    expect(result).toMatchObject({ ok: false });
    expect(result && "preview" in result ? result.preview?.counts.error : null).toBe(1);
    expect((await ctx.db.select().from(people)).length).toBe(peopleBefore);
    expect((await ctx.db.select().from(eventPeople)).length).toBe(linksBefore);
    expect(
      await ctx.db.query.people.findFirst({ where: eq(people.email, "no-write@example.com") }),
    ).toBeUndefined();
  });
});

describe("send-invite (SPK-06)", () => {
  it("MUST FIRE: a single-row send logs a comm_log row with the portal_invite template", async () => {
    const speakerId = fixture.speakerIds[0];
    const result = await post({ intent: "send-invite", personId: speakerId });
    expect(result).toMatchObject({ ok: true });
    expect((result as { notice: string }).notice).toMatch(/portal invite sent/i);

    const rows = await listComms({ eventId: EVENT_ID, personId: speakerId, db: ctx.db });
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows[0].templateKey).toBe("portal_invite");
  });

  it("MUST FIRE: bulk send (repeated personId) logs one row per recipient", async () => {
    const [a, b] = fixture.speakerIds;
    const result = await postMulti([
      ["intent", "send-invite"],
      ["personId", a],
      ["personId", b],
    ]);
    expect(result).toMatchObject({ ok: true });
    expect((result as { notice: string }).notice).toMatch(/2 speakers/i);

    const rowsA = await listComms({ eventId: EVENT_ID, personId: a, db: ctx.db });
    const rowsB = await listComms({ eventId: EVENT_ID, personId: b, db: ctx.db });
    expect(rowsA.some((row) => row.templateKey === "portal_invite")).toBe(true);
    expect(rowsB.some((row) => row.templateKey === "portal_invite")).toBe(true);
  });

  it("MUST NOT FIRE: no personId selected sends nothing and logs nothing", async () => {
    const before = await listComms({ eventId: EVENT_ID, db: ctx.db });
    const result = await post({ intent: "send-invite" });
    expect(result).toMatchObject({
      ok: false,
      error: "Select at least one speaker to invite.",
    });
    const after = await listComms({ eventId: EVENT_ID, db: ctx.db });
    expect(after.length).toBe(before.length);
  });

  it("renders a per-row Send portal invite button and a bulk button on the roster", async () => {
    const html = render(await load());
    expect(html).toContain("Send portal invite to selected");
    expect(html).toContain("Send portal invite");
    expect(html).toContain('id="invite-bulk-form"');
  });
});

describe("event isolation", () => {
  it("shows a newly added speaker in event A and not event B", async () => {
    await seedOtherEvent(ctx.db);
    await post({ intent: "add-speaker", fullName: "Event A Only", email: "a-only@example.com" });

    const eventA = await load();
    const eventB = await load(
      `https://x.test/admin/speakers?event=${encodeURIComponent(OTHER_EVENT_SLUG)}`,
    );

    expect(eventA.speakers.map((row) => row.fullName)).toContain("Event A Only");
    expect(eventB.speakers.map((row) => row.fullName)).not.toContain("Event A Only");
  });
});
