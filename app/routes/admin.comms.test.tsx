/**
 * The comm log view: the values it reports, the per-speaker filter, and both
 * empty states. Failed rows are asserted explicitly — the whole point of the
 * screen is that a rejected send is visible, not just absent.
 */
import { eq } from "drizzle-orm";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { events, sessions } from "~/db/schema";
import type { Event as EventRow } from "~/db/schema";
import { recordComm } from "~/lib/comms/comm-log.server";
import { notifyScheduleChange } from "~/lib/comms/schedule-invite.server";
import { MemoryMailer } from "~/lib/mail/mailer";
import { signedInGet } from "~/test/auth";
import { installTestDb, type TestDbContext } from "~/test/db";
import { seedDemoFixture, type DemoFixture } from "~/test/fixtures";

import AdminComms, { CommsView, loader } from "./admin.comms";

type LoaderArgs = Parameters<typeof loader>[0];

let ctx: TestDbContext;
let fixture: DemoFixture;
let event: EventRow;

beforeEach(async () => {
  ctx = installTestDb();
  fixture = await seedDemoFixture(ctx.db);
  [event] = await ctx.db.select().from(events).where(eq(events.id, fixture.eventId));
});
afterEach(() => ctx.close());

async function load(query = "") {
  const request = await signedInGet(`https://x.test/admin/comms${query}`, fixture.adminId);
  return loader({ request, params: {}, context: {} } as unknown as LoaderArgs);
}

/** Drive a real invite through the seam so the rows are the product's own. */
async function sendInvite() {
  const sessionId = fixture.programSessionIds[0];
  const row = await ctx.db.query.sessions.findFirst({ where: eq(sessions.id, sessionId) });
  return notifyScheduleChange({
    request: new Request("https://callboard.test/admin/agenda"),
    event,
    sessionId,
    change: "scheduled",
    before: {
      startsAt: row?.startsAt ?? null,
      endsAt: row?.endsAt ?? null,
      isPublic: row?.isPublic ?? false,
    },
    db: ctx.db,
    mailer: new MemoryMailer(),
  });
}

describe("zero state", () => {
  it("MUST-FIRE: renders with no rows at all and says what to do", async () => {
    const data = await load();
    expect(data.rows).toEqual([]);
    expect(data.counts).toEqual({ total: 0, sent: 0, failed: 0 });

    const html = renderToStaticMarkup(<CommsView {...data} />);
    expect(html).toContain('data-testid="comms-zero"');
    expect(html).toContain("task-reminders");
    // The filter is still usable with an empty log.
    expect(html).toContain('data-testid="comms-filter"');
  });

  it("still lists the event roster in the filter when nothing has been sent", async () => {
    const data = await load();
    expect(data.people.length).toBeGreaterThan(0);
    expect(data.people.map((person) => person.email)).toContain("speaker@callboard.dev");
  });

  it("renders the no-event state", () => {
    const html = renderToStaticMarkup(
      <CommsView
        event={null}
        rows={[]}
        people={[]}
        personId={null}
        personName={null}
        counts={{ total: 0, sent: 0, failed: 0 }}
      />,
    );
    expect(html).toContain('data-testid="comms-empty"');
  });
});

describe("seeded state", () => {
  beforeEach(async () => {
    await sendInvite();
    await recordComm(
      { to: "rina@example.com", subject: "1 thing(s) left before Frontier AI Summit 2026" },
      { ok: false, error: "resend: HTTP 403 — domain not verified" },
      {
        eventId: fixture.eventId,
        personId: fixture.speakerIds[1],
        templateKey: "task_reminder",
        db: ctx.db,
      },
    );
  });

  it("MUST-FIRE: reports the exact counts, not just a rendered page", async () => {
    const data = await load();
    expect(data.counts).toEqual({ total: 2, sent: 1, failed: 1 });
    expect(data.rows.map((row) => row.status).sort()).toEqual(["failed", "sent"]);
  });

  it("MUST-FIRE: the failed row carries its provider error into the page", async () => {
    const data = await load();
    const html = renderToStaticMarkup(<CommsView {...data} />);

    expect(html).toContain('data-testid="comm-status-failed"');
    expect(html).toContain("domain not verified");
    expect(html).toContain("Task reminder");
  });

  it("MUST-FIRE / MUST-NOT-FIRE: labels accepted mail honestly while failed mail stays failed", async () => {
    const data = await load();
    const html = renderToStaticMarkup(<CommsView {...data} />);

    expect(html).toContain("Accepted by mail service");
    expect(html).toContain("1 accepted by mail service");
    expect(html).not.toContain(">sent</span>");
    expect(html).not.toContain(" sent ·");
    expect(html).toContain(">failed</span>");
    expect(data.rows.map((row) => row.status).sort()).toEqual(["failed", "sent"]);
  });

  it("shows the ICS method and sequence on a calendar send", async () => {
    const data = await load();
    const invite = data.rows.find((row) => row.templateKey === "schedule_invite");
    expect(invite?.meta?.icsMethod).toBe("REQUEST");
    expect(invite?.meta?.icsSequence).toBe(0);

    const html = renderToStaticMarkup(<CommsView {...data} />);
    expect(html).toContain("REQUEST");
    expect(html).toContain("seq 0");
  });

  it("names the recipient when they are on the event roster", async () => {
    const data = await load();
    const invite = data.rows.find((row) => row.toEmail === "speaker@callboard.dev");
    expect(invite?.personName).toBe("Sam Speaker");
  });

  it("MUST-FIRE: the per-speaker filter narrows to one person", async () => {
    const data = await load(`?person=${fixture.speakerIds[1]}`);
    expect(data.personId).toBe(fixture.speakerIds[1]);
    expect(data.personName).toBe("Rina Okafor");
    expect(data.rows).toHaveLength(1);
    expect(data.rows[0].toEmail).toBe("rina@example.com");
    expect(data.counts).toEqual({ total: 1, sent: 0, failed: 1 });
  });

  it("MUST-NOT-FIRE: a speaker with no comms shows the filtered zero state", async () => {
    const data = await load(`?person=${fixture.speakerIds[5]}`);
    expect(data.rows).toEqual([]);

    const html = renderToStaticMarkup(<CommsView {...data} />);
    expect(html).toContain(
      "No messages have been accepted by the mail service for this speaker yet.",
    );
  });

  it("renders a row per message with the table headings", async () => {
    const data = await load();
    const html = renderToStaticMarkup(<CommsView {...data} />);
    expect(html.split('data-testid="comm-row"').length - 1).toBe(2);
    expect(html).toContain('data-testid="comms-table"');
  });

  it("the ROUTE default export renders the same screen from loader data", async () => {
    const props = { loaderData: await load() } as unknown as Parameters<typeof AdminComms>[0];
    expect(renderToStaticMarkup(<AdminComms {...props} />)).toContain('data-testid="comms"');
  });
});
