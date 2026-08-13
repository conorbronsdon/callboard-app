/** Route-level compose loader/action/view proofs; existing history tests stay untouched. */
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { commLog, eventPeople, people } from "~/db/schema";
import { DEFAULT_TEMPLATES } from "~/lib/comms/templates";
import { signedInGet } from "~/test/auth";
import { installTestDb, type TestDbContext } from "~/test/db";
import { seedDemoFixture, type DemoFixture } from "~/test/fixtures";

import { CommsView, action, loader, type CommsActionData } from "./admin.comms";

type LoaderArgs = Parameters<typeof loader>[0];
type ActionArgs = Parameters<typeof action>[0];

let ctx: TestDbContext;
let fixture: DemoFixture;

beforeEach(async () => {
  ctx = installTestDb({ MAIL_DRIVER: "console" });
  fixture = await seedDemoFixture(ctx.db);
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
  ctx.close();
});

async function load(query = "") {
  const request = await signedInGet(`https://callboard.test/admin/comms${query}`, fixture.adminId);
  return loader({ request, params: {}, context: {} } as unknown as LoaderArgs);
}

async function post(entries: [string, string][]) {
  const auth = await signedInGet("https://callboard.test/admin/comms", fixture.adminId);
  const body = new URLSearchParams();
  for (const [key, value] of entries) body.append(key, value);
  const request = new Request(auth.url, {
    method: "POST",
    headers: {
      cookie: auth.headers.get("cookie") ?? "",
      "content-type": "application/x-www-form-urlencoded",
    },
    body,
  });
  return action({ request, params: {}, context: {} } as unknown as ActionArgs);
}

function composeEntries(overrides: Record<string, string> = {}, recipientIds = [fixture.speakerIds[0]]) {
  const fields: [string, string][] = [
    ["intent", "preview"],
    ["audience", "all_speakers"],
    ["trackId", ""],
    ["templateKey", "task_reminder"],
    ["subject", "Welcome {{speaker.first_name}}"],
    ["body", "Hi {{speaker.first_name}} — {{session.title}}.\n{{task.list}}"],
    ["previewPersonId", recipientIds[0] ?? ""],
  ];
  for (const [key, value] of Object.entries(overrides)) {
    const index = fields.findIndex(([field]) => field === key);
    if (index >= 0) fields[index] = [key, value];
    else fields.push([key, value]);
  }
  return [...fields, ...recipientIds.map((id) => ["recipientIds", id] as [string, string])];
}

async function composeSendEntries(
  overrides: Record<string, string> = {},
  recipientIds = [fixture.speakerIds[0]],
) {
  const data = await load();
  const compose = data.compose!;
  return composeEntries(
    {
      intent: "send",
      audienceVersion: compose.audienceVersion,
      audienceCount: String(compose.filteredRecipientIds.length),
      submitNonce: compose.submitNonce,
      ...overrides,
    },
    recipientIds,
  );
}

describe("compose loader and view", () => {
  it("loads a template's raw tokens and prechecks the outstanding-task audience", async () => {
    const data = await load("?audience=outstanding_tasks&template=task_reminder");
    expect(data.compose?.templateKey).toBe("task_reminder");
    expect(data.compose?.subject).toBe(DEFAULT_TEMPLATES.task_reminder.subject);
    expect(data.compose?.body).toContain("{{speaker.first_name}}");
    expect([...data.compose!.filteredRecipientIds].sort()).toEqual([...fixture.speakerIds.slice(0, 2)].sort());

    const html = renderToStaticMarkup(<CommsView {...data} />);
    expect(html).toContain('data-testid="comms-compose"');
    expect(html).toContain("{{speaker.first_name}}");
    expect(html.split('name="recipientIds"').length - 1).toBe(2);
    expect(html).toContain("2 of 2 selected");
    expect(html).toContain('name="subject"');
    expect(html).toContain('name="body"');
    expect(html).toContain('name="audienceVersion"');
    expect(html).toContain('name="audienceCount" value="2"');
    expect(html).toContain('name="submitNonce"');
  });

  it("MUST-NOT-FIRE: all-speakers excludes the organizer but includes every seeded speaker", async () => {
    const data = await load("?audience=all_speakers");
    expect([...data.compose!.filteredRecipientIds].sort()).toEqual([...fixture.speakerIds].sort());
    expect(data.compose?.filteredRecipientIds).not.toContain(fixture.adminId);
  });

  it("track filtering is event scoped and a blank track selects nobody", async () => {
    const blank = await load("?audience=track");
    expect(blank.compose?.filteredRecipientIds).toEqual([]);
    const filtered = await load(`?audience=track&track=${fixture.trackIds[0]}`);
    expect(filtered.compose?.filteredRecipientIds.length).toBeGreaterThan(0);
  });
});

describe("compose action", () => {
  it("MUST-FIRE: preview renders concrete speaker data beside the tokenized body", async () => {
    const result = (await post(composeEntries())) as CommsActionData;
    expect(result.ok).toBe(true);
    if (!result.ok || result.intent !== "preview") throw new Error("expected preview");
    expect(result.preview.personName).toBe("Sam Speaker");
    expect(result.preview.subject).toBe("Welcome Sam");
    expect(result.preview.text).toContain("Hi Sam — Shipping agents that survive contact with users");
    expect(result.preview.text).not.toContain("{{");

    const data = await load();
    const html = renderToStaticMarkup(<CommsView {...data} actionData={result} />);
    expect(html).toContain('data-testid="comms-preview"');
    expect(html).toContain("Rendered for Sam Speaker");
    expect(html).toContain("Welcome Sam");
    expect(html).toContain("{{speaker.first_name}}");
  });

  it("MUST-NOT-FIRE: empty selection returns an error and writes zero log rows", async () => {
    const result = (await post(composeEntries({}, []))) as CommsActionData;
    expect(result).toMatchObject({ ok: false });
    if (result.ok) throw new Error("expected validation error");
    expect(result.error).toContain("Select at least one recipient");
    expect(await ctx.db.select().from(commLog)).toHaveLength(0);
  });

  it("MUST-NOT-FIRE complement: a valid same-shape send redirects and history records each recipient", async () => {
    const recipientIds = fixture.speakerIds.slice(0, 2);
    const result = await post(
      await composeSendEntries(
        {
          templateKey: "",
          subject: "Welcome to DevFlow Conf 2027 speakers",
          body: "Hi {{speaker.first_name}}, welcome to {{event.name}}.",
        },
        recipientIds,
      ),
    );
    expect(result).toBeInstanceOf(Response);
    expect((result as Response).headers.get("location")).toBe("/admin/comms?sent=2&failed=0");
    const rows = await ctx.db.select().from(commLog);
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.subject === "Welcome to DevFlow Conf 2027 speakers")).toBe(true);

    const data = await load("?sent=2&failed=0");
    const html = renderToStaticMarkup(<CommsView {...data} />);
    expect(html).toContain("Accepted by mail service: 2 of 2");
    expect(data.counts).toEqual({ total: 2, sent: 2, failed: 0 });
  });

  it("MUST-FIRE: a stale audience refuses the send and writes zero messages", async () => {
    const rendered = await load();
    const compose = rendered.compose!;
    const staleCount = compose.filteredRecipientIds.length;
    const addedPersonId = "comms-race-speaker";
    await ctx.db.insert(people).values({
      id: addedPersonId,
      email: "late.speaker@example.com",
      fullName: "Late Speaker",
      role: "speaker",
    });
    await ctx.db.insert(eventPeople).values({
      eventId: fixture.eventId,
      personId: addedPersonId,
      eventRole: "speaker",
    });

    const result = (await post(
      composeEntries(
        {
          intent: "send",
          templateKey: "",
          subject: "Stale audience must not send",
          body: "Review the recipients first.",
          audienceVersion: compose.audienceVersion,
          audienceCount: String(staleCount),
        },
        compose.filteredRecipientIds,
      ),
    )) as CommsActionData;

    expect(result).toMatchObject({
      ok: false,
      error: `Your recipient list changed (was ${staleCount}, now ${staleCount + 1}) — review and confirm again.`,
    });
    expect(await ctx.db.select().from(commLog)).toEqual([]);
  });

  it("MUST-FIRE: a missing audience fingerprint is refused", async () => {
    const result = (await post(
      composeEntries({
        intent: "send",
        templateKey: "",
        subject: "Missing snapshot",
        body: "This hand-built request must not bypass the guard.",
      }),
    )) as CommsActionData;

    expect(result).toMatchObject({
      ok: false,
      error: expect.stringContaining("Your recipient list changed"),
    });
    expect(await ctx.db.select().from(commLog)).toEqual([]);
  });

  it("MUST-FIRE: a double-click (replayed submit nonce) sends once, not twice (issue #198)", async () => {
    const entries = await composeSendEntries({
      templateKey: "",
      subject: "Schedule change",
      body: "Your session has moved rooms.",
    });

    // Two POSTs of the SAME rendered form — exactly what a double-click or a
    // client's automatic retry of a slow request produces.
    const [first, second] = await Promise.all([post(entries), post(entries)]);

    const responses = [first, second];
    const sentOne = responses.filter((r) => r instanceof Response);
    const refused = responses.filter((r) => !(r instanceof Response)) as CommsActionData[];
    expect(sentOne, "exactly one of the two concurrent posts should redirect").toHaveLength(1);
    expect(refused, "the other should be refused, not silently dropped").toHaveLength(1);
    expect(refused[0]).toMatchObject({ ok: false, error: expect.stringMatching(/already sent/i) });

    expect(await ctx.db.select().from(commLog)).toHaveLength(1);
  });

  it("MUST-NOT-FIRE complement: a normal single send with a fresh nonce still sends once", async () => {
    const entries = await composeSendEntries({
      templateKey: "",
      subject: "Schedule change",
      body: "Your session has moved rooms.",
    });
    const result = await post(entries);
    expect(result).toBeInstanceOf(Response);
    expect(await ctx.db.select().from(commLog)).toHaveLength(1);
  });

  it("MUST-FIRE: a free-form send is named in history, not shown as its sentinel key", async () => {
    const result = await post(
      await composeSendEntries(
        { templateKey: "", subject: "Plain subject", body: "Plain body" },
        [fixture.speakerIds[0]],
      ),
    );
    expect(result).toBeInstanceOf(Response);
    const [row] = await ctx.db.select().from(commLog);
    // The stored key stays the sentinel — the cron dedupe reads this column.
    expect(row.meta?.templateKey).toBe("bulk_custom");

    const html = renderToStaticMarkup(<CommsView {...(await load())} />);
    // ...but the organizer sees a name, and never the raw key.
    expect(html).toContain("Bulk email");
    expect(html).not.toContain(">bulk_custom<");
  });

  it("refuses a blank or foreign track id but accepts the matching track", async () => {
    const blank = (await post(composeEntries({ audience: "track", trackId: "" }))) as CommsActionData;
    expect(blank).toMatchObject({ ok: false });
    const foreign = (await post(composeEntries({ audience: "track", trackId: "other" }))) as CommsActionData;
    expect(foreign).toMatchObject({ ok: false });
    const valid = (await post(composeEntries({ audience: "track", trackId: fixture.trackIds[0] }))) as CommsActionData;
    expect(valid).toMatchObject({ ok: true, intent: "preview" });
  });

  it("returns the templates-route no-event shape", async () => {
    ctx.close();
    ctx = installTestDb({ MAIL_DRIVER: "console" });
    await ctx.db.insert(people).values({
      id: fixture.adminId,
      email: "admin-no-event@example.com",
      fullName: "Admin",
      role: "admin",
    });
    const result = (await post(composeEntries())) as CommsActionData;
    expect(result).toEqual({
      ok: false,
      error: "No event exists yet. Create one in Settings first.",
    });
    expect(await ctx.db.select().from(eventPeople)).toHaveLength(0);
  });
});
