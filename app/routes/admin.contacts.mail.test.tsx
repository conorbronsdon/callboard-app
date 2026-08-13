import { and, eq, inArray, sql } from "drizzle-orm";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { commLog, eventPeople, events, people } from "~/db/schema";
import { MERGE_FALLBACKS } from "~/lib/comms/bulk";
import { MemoryMailer, type MailMessage, type Mailer } from "~/lib/mail/mailer";
import { signedInGet } from "~/test/auth";
import { installTestDb, type TestDbContext } from "~/test/db";
import { seedDemoFixture, type DemoFixture } from "~/test/fixtures";

const mailerHarness = vi.hoisted(() => ({ current: undefined as Mailer | undefined }));

vi.mock("~/lib/mail/mailer.server", () => ({
  getMailer: () => {
    if (!mailerHarness.current) throw new Error("Test mailer is not installed.");
    return mailerHarness.current;
  },
}));

import { ContactsScreen, action, loader } from "./admin.contacts";

type ActionArgs = Parameters<typeof action>[0];
type LoaderArgs = Parameters<typeof loader>[0];

const BASE = "https://callboard.test/admin/contacts";
let ctx: TestDbContext;
let fixture: DemoFixture;
let mailer: MemoryMailer;

beforeEach(async () => {
  ctx = installTestDb({ MAIL_DRIVER: "console" });
  fixture = await seedDemoFixture(ctx.db);
  mailer = new MemoryMailer();
  mailerHarness.current = mailer;
  await ctx.db.insert(people).values([
    { id: "prospect-a", email: "prospect.a@example.com", fullName: "Prospect Alpha" },
    { id: "prospect-b", email: "prospect.b@example.com", fullName: "Prospect Beta" },
  ]);
});

afterEach(() => {
  mailerHarness.current = undefined;
  vi.restoreAllMocks();
  ctx.close();
});

async function post(entries: [string, string][]) {
  const auth = await signedInGet(BASE, fixture.adminId);
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

function composeEntries(
  overrides: Record<string, string> = {},
  personIds = ["prospect-a", "prospect-b"],
): [string, string][] {
  const entries: [string, string][] = [
    ["intent", "send-bulk"],
    ["contextEventId", fixture.eventId],
    ["subject", "Hello {{speaker.first_name}}"],
    ["body", "Welcome to {{event.name}}."],
  ];
  for (const [key, value] of Object.entries(overrides)) {
    const index = entries.findIndex(([name]) => name === key);
    if (index >= 0) entries[index] = [key, value];
    else entries.push([key, value]);
  }
  return [...entries, ...personIds.map((id) => ["personId", id] as [string, string])];
}

describe("contact directory bulk mail", () => {
  it("MUST FIRE: mails contacts with no event and logs both addresses", async () => {
    const membershipCount = await ctx.db
      .select({ count: sql<number>`count(*)` })
      .from(eventPeople)
      .where(inArray(eventPeople.personId, ["prospect-a", "prospect-b"]));
    expect(membershipCount[0]?.count).toBe(0);

    expect(await post(composeEntries())).toMatchObject({
      ok: true,
      intent: "send-bulk",
      notice: "Sent 2 of 2.",
    });
    expect(mailer.sent).toHaveLength(2);
    const logged = await ctx.db
      .select()
      .from(commLog)
      .where(inArray(commLog.personId, ["prospect-a", "prospect-b"]));
    expect(logged.map((row) => row.toEmail).sort()).toEqual([
      "prospect.a@example.com",
      "prospect.b@example.com",
    ]);
    expect(logged.every((row) => row.meta?.audience === "org_contacts")).toBe(true);
  });

  it("MUST FIRE: session tokens use fallbacks and event tokens use the chosen event", async () => {
    const [event] = await ctx.db.select().from(events).where(eq(events.id, fixture.eventId));
    await post(composeEntries({ body: "{{session.title}} at {{event.name}}" }, ["prospect-a"]));
    expect(mailer.sent[0]?.text).toBe(
      `${MERGE_FALLBACKS["session.title"]} at ${event.name}`,
    );
  });

  it("MUST NOT FIRE: refuses an unknown person and sends or logs nothing", async () => {
    const result = await post(composeEntries({}, ["prospect-a", "unknown-person"]));
    expect(result).toMatchObject({
      ok: false,
      error: "1 selected contacts do not exist. Nothing was sent.",
    });
    expect(mailer.sent).toHaveLength(0);
    expect(await ctx.db.select().from(commLog)).toHaveLength(0);
  });

  it("MUST NOT FIRE: refuses blank subjects and blank bodies without sending", async () => {
    expect(await post(composeEntries({ subject: "   " }, ["prospect-a"]))).toMatchObject({
      ok: false,
    });
    expect(await post(composeEntries({ body: "   " }, ["prospect-a"]))).toMatchObject({
      ok: false,
    });
    expect(mailer.sent).toHaveLength(0);
    expect(await ctx.db.select().from(commLog)).toHaveLength(0);
  });

  it("MUST NOT FIRE: refuses a merged-away tombstone", async () => {
    await ctx.db.update(people).set({ mergedInto: "prospect-a" }).where(eq(people.id, "prospect-b"));
    const result = await post(composeEntries({}, ["prospect-b"]));
    expect(result).toMatchObject({
      ok: false,
      error: "1 selected contacts do not exist. Nothing was sent.",
    });
    expect(mailer.sent).toHaveLength(0);
    expect(await ctx.db.select().from(commLog)).toHaveLength(0);
  });

  it("MUST FIRE: logs a thrown provider failure and reports the failed count", async () => {
    const attempted: MailMessage[] = [];
    let calls = 0;
    mailerHarness.current = {
      name: "fallible",
      observesDelivery: true,
      async send(message) {
        attempted.push(message);
        calls += 1;
        if (calls === 1) throw new Error("provider unavailable");
        return { ok: true, id: "sent-2" };
      },
    };

    expect(await post(composeEntries())).toMatchObject({
      ok: true,
      intent: "send-bulk",
      notice: "Sent 1 of 2; 1 failed.",
    });
    expect(attempted).toHaveLength(2);
    const logged = await ctx.db
      .select()
      .from(commLog)
      .where(inArray(commLog.personId, ["prospect-a", "prospect-b"]));
    expect(logged).toHaveLength(2);
    expect(logged.map((row) => row.status).sort()).toEqual(["failed", "sent"]);
    expect(logged.find((row) => row.status === "failed")?.error).toBe("provider unavailable");
  });

  it("requires a real merge-field event and renders the compose panel", async () => {
    expect(await post(composeEntries({ contextEventId: "" }, ["prospect-a"]))).toMatchObject({
      ok: false,
      error: "Choose an event to supply the merge-field context.",
    });
    expect(await post(composeEntries({ contextEventId: "missing" }, ["prospect-a"]))).toMatchObject({
      ok: false,
      error: "Choose an event to supply the merge-field context.",
    });
    expect(mailer.sent).toHaveLength(0);

    const request = await signedInGet(BASE, fixture.adminId);
    const data = await loader({ request, params: {}, context: {} } as unknown as LoaderArgs);
    const html = renderToStaticMarkup(<ContactsScreen data={data} />);
    expect(html).toContain('data-testid="contact-compose"');
    expect(html).toContain('name="contextEventId"');
    expect(html).toContain('name="subject"');
    expect(html).toContain('name="body"');
    expect(html).toContain('value="send-bulk"');
  });
});
