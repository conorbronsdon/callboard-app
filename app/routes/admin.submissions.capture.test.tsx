/**
 * Capture on behalf of a speaker — the write, and everything the write must NOT
 * do.
 *
 * The claim this feature makes to an organizer is "paste it in; nothing is
 * sent". A test that only checks the row landed proves the interesting half of
 * that sentence and none of the frightening half, so every must-not-fire
 * assertion below is paired with a control on the SAME database that drives the
 * same counter off zero. A `toHaveLength(0)` on a table nothing ever writes to
 * in a unit test is not evidence; it is a green check that cannot fail.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  authTokens,
  commLog,
  events,
  forms,
  people,
  sessionParticipants,
  sessions,
  tasks,
} from "~/db/schema";
import { CAPTURE_KEY, captureProvenance } from "~/lib/capture";
import { toFormDefinition } from "~/lib/public-submit/contract";
import { submitDraft, type DraftView } from "~/lib/public-submit/draft.server";
import { commitQueues } from "~/lib/review/commit.server";
import { signedInGet, signedInPost } from "~/test/auth";
import { installTestDb, type TestDbContext } from "~/test/db";
import { CFP_FORM_ID, EVENT_ID, seedDemoFixture, type DemoFixture } from "~/test/fixtures";

import { action } from "./admin.submissions";
import { SubmissionDetailView, loader as detailLoader } from "./admin.submission";

type ActionArgs = Parameters<typeof action>[0];
type DetailLoaderArgs = Parameters<typeof detailLoader>[0];

const asActionArgs = (request: Request) =>
  ({ request, params: {}, context: {} }) as unknown as ActionArgs;

let ctx: TestDbContext;
let fixture: DemoFixture;

beforeEach(async () => {
  ctx = installTestDb();
  fixture = await seedDemoFixture(ctx.db);
});
afterEach(() => ctx.close());

async function capture(fields: Record<string, string>) {
  const request = await signedInPost(
    "https://x.test/admin/submissions",
    fixture.adminId,
    { intent: "capture-on-behalf", ...fields },
  );
  return action(asActionArgs(request));
}

/** The row the capture just wrote — newest abstract with a provenance block. */
async function capturedRow() {
  const rows = await ctx.db.select().from(sessions).where(eq(sessions.eventId, EVENT_ID));
  return rows.find((row) => captureProvenance(row.answers) !== null) ?? null;
}

describe("capture-on-behalf — the write", () => {
  it("records a verbatim pitch as a pending abstract with provenance", async () => {
    const pasted = "Hi — I run infra at Acme.\n\nI'd love to talk about D1 at scale.";
    const result = await capture({ pasted, source: "email", speakerEmail: "nina@acme.test" });
    expect(result).toBeInstanceOf(Response);
    expect((result as Response).headers.get("location")).toContain("created=capture");

    const row = await capturedRow();
    expect(row).not.toBeNull();
    expect(row!.status).toBe("pending");
    expect(row!.isAbstract).toBe(true);
    expect(row!.isPublic).toBe(false);
    // Verbatim: the paste is stored, not summarised, not re-wrapped.
    expect(row!.description).toBe(pasted);
    // No form produced it, so it must not claim one.
    expect(row!.formId).toBeNull();
    expect(row!.friendlyId).toMatch(/^ABS-\d+$/);

    const provenance = captureProvenance(row!.answers)!;
    expect(provenance.byPersonId).toBe(fixture.adminId);
    expect(provenance.source).toBe("email");
    expect(provenance.capturedAt).toBeGreaterThan(0);
  });

  it("titles an untitled pitch from its first line, and a blank one from nothing", async () => {
    await capture({ pasted: "Cost modelling for agents\n\nrest of the DM", source: "dm" });
    expect((await capturedRow())!.title).toBe("Cost modelling for agents");

    ctx.close();
    ctx = installTestDb();
    fixture = await seedDemoFixture(ctx.db);
    await capture({});
    expect((await capturedRow())!.title).toBe("Untitled capture");
  });

  it("attaches to the EXISTING person for a known address without touching their profile", async () => {
    const before = (await ctx.db.query.people.findMany()).length;
    const known = await ctx.db.query.people.findFirst({
      where: eq(people.email, "rina@example.com"),
    });
    expect(known).toBeDefined();

    await capture({
      pasted: "Pitch",
      speakerEmail: "RINA@example.com",
      speakerName: "Not Her Real Name",
    });

    // No new person: the same human at the same address is the same id.
    expect((await ctx.db.query.people.findMany()).length).toBe(before);
    const after = await ctx.db.query.people.findFirst({ where: eq(people.id, known!.id) });
    expect(after!.fullName).toBe(known!.fullName);
    expect(after!.bio).toBe(known!.bio);

    const row = await capturedRow();
    const links = await ctx.db
      .select()
      .from(sessionParticipants)
      .where(eq(sessionParticipants.sessionId, row!.id));
    expect(links).toHaveLength(1);
    expect(links[0].personId).toBe(known!.id);
    expect(links[0].isPrimary).toBe(true);
    expect(captureProvenance(row!.answers)!.contactName).toBeNull();
  });

  it("creates a person for an unknown address", async () => {
    await capture({ pasted: "Pitch", speakerEmail: "new@acme.test", speakerName: "New Speaker" });
    const created = await ctx.db.query.people.findFirst({
      where: eq(people.email, "new@acme.test"),
    });
    expect(created).toBeDefined();
    expect(created!.fullName).toBe("New Speaker");

    const row = await capturedRow();
    const links = await ctx.db
      .select()
      .from(sessionParticipants)
      .where(eq(sessionParticipants.sessionId, row!.id));
    expect(links.map((link) => link.personId)).toEqual([created!.id]);
  });

  it("records an unlinked pitch when no email was given — must not invent a person", async () => {
    const before = (await ctx.db.query.people.findMany()).length;
    await capture({ pasted: "Someone in the hallway", source: "hallway", speakerName: "Tall guy" });

    expect((await ctx.db.query.people.findMany()).length).toBe(before);
    const row = await capturedRow();
    const links = await ctx.db
      .select()
      .from(sessionParticipants)
      .where(eq(sessionParticipants.sessionId, row!.id));
    expect(links).toHaveLength(0);

    const provenance = captureProvenance(row!.answers)!;
    expect(provenance.contactName).toBe("Tall guy");
    expect(provenance.contactNote).toContain("No email");
  });

  it("refuses a malformed email and writes nothing", async () => {
    const before = (await ctx.db.select().from(sessions).where(eq(sessions.eventId, EVENT_ID)))
      .length;
    const result = await capture({ pasted: "Pitch", speakerEmail: "nina@" });
    expect(result).not.toBeInstanceOf(Response);
    expect((result as { ok: false; error: string }).ok).toBe(false);
    expect(
      (await ctx.db.select().from(sessions).where(eq(sessions.eventId, EVENT_ID))).length,
    ).toBe(before);
  });
});

/* ------------------------------------------------------------ must not fire */

describe("capture-on-behalf — nothing is sent", () => {
  it("creates zero mail, zero tasks and zero auth tokens, and the counters still work", async () => {
    const mailBefore = (await ctx.db.select().from(commLog)).length;
    const taskBefore = (await ctx.db.select().from(tasks)).length;
    const tokenBefore = (await ctx.db.select().from(authTokens)).length;

    await capture({
      pasted: "I'd love to give this talk.",
      speakerEmail: "silent@acme.test",
      speakerName: "Silent Speaker",
    });

    expect((await ctx.db.select().from(commLog)).length).toBe(mailBefore);
    expect((await ctx.db.select().from(tasks)).length).toBe(taskBefore);
    expect((await ctx.db.select().from(authTokens)).length).toBe(tokenBefore);

    /* ── controls: the same three counters, driven off zero ───────────────
     * Without these, the three assertions above would pass on a database
     * where nothing can write those tables at all. */

    // (1) mail — the ordinary public submit sends a confirmation and logs it.
    const draftId = crypto.randomUUID();
    const submitter = (await ctx.db.query.people.findFirst({
      where: eq(people.email, "speaker@callboard.dev"),
    }))!;
    const participants: DraftView["participants"] = [
      {
        role: "speaker",
        firstName: "Sam",
        lastName: "Speaker",
        email: submitter.email,
        isPrimary: true,
        answers: {},
      },
    ];
    await ctx.db.insert(sessions).values({
      id: draftId,
      eventId: EVENT_ID,
      formId: CFP_FORM_ID,
      title: "A control submission",
      status: "draft",
      isAbstract: true,
      answers: { fields: { title: "A control submission" }, participants, __content: {} },
    });
    await ctx.db.insert(sessionParticipants).values({
      sessionId: draftId,
      personId: submitter.id,
      role: "speaker",
      isPrimary: true,
      order: 0,
    });
    const event = (await ctx.db.query.events.findFirst({ where: eq(events.id, EVENT_ID) }))!;
    const form = (await ctx.db.query.forms.findFirst({ where: eq(forms.id, CFP_FORM_ID) }))!;
    const submitted = await submitDraft({
      request: new Request("https://x.test/submit"),
      event,
      form,
      def: toFormDefinition(form),
      draft: {
        id: draftId,
        status: "draft",
        title: "A control submission",
        fields: { title: "A control submission", abstract: "Body." },
        participants,
        content: {
          mode: "abstract",
          videoUrl: "",
          uploadKey: null,
          uploadName: null,
          uploadSize: null,
        },
      },
      submitter,
    });
    expect(submitted.ok).toBe(true);
    expect((await ctx.db.select().from(commLog)).length).toBeGreaterThan(mailBefore);

    // (2) tasks — committing the accept queue instantiates the templates.
    const committed = await commitQueues(EVENT_ID);
    expect(committed.tasksCreated).toBeGreaterThan(0);
    expect((await ctx.db.select().from(tasks)).length).toBeGreaterThan(taskBefore);

    // (3) auth tokens — a magic link writes one; capture never mints any.
    await ctx.db.insert(authTokens).values({
      personId: fixture.adminId,
      tokenHash: "control-hash",
      expiresAt: new Date(Date.now() + 60_000),
    });
    expect((await ctx.db.select().from(authTokens)).length).toBeGreaterThan(tokenBefore);
  });

  it("leaves the ordinary accepted flow untouched — must still fire", async () => {
    // Capture first, then commit: the captured row is Pending, so it must be
    // among the rows the commit deliberately does NOT touch, and the accept
    // queue must still compose and create tasks exactly as before.
    await capture({ pasted: "A pitch that must not join the accept queue." });
    const captured = await capturedRow();

    const result = await commitQueues(EVENT_ID);
    expect(result.accepted).toBe(1);
    expect(result.declined).toBe(1);
    expect(result.sessionsComposed).toBe(1);
    expect(result.tasksCreated).toBeGreaterThan(0);

    const after = await ctx.db.query.sessions.findFirst({
      where: eq(sessions.id, captured!.id),
    });
    expect(after!.status).toBe("pending");
    expect(after!.composedIntoSessionId).toBeNull();
  });
});

/* ------------------------------------------------------------- provenance UI */

describe("provenance is visible on the submission detail", () => {
  it("renders the captured-by banner, and does not render it for a form submission", async () => {
    await capture({
      pasted: "Pasted from an email.",
      source: "email",
      speakerEmail: "banner@acme.test",
    });
    const captured = await capturedRow();

    const detail = await detailLoader({
      request: await signedInGet(
        `https://x.test/admin/submissions/${captured!.id}`,
        fixture.adminId,
      ),
      params: { id: captured!.id },
      context: {},
    } as unknown as DetailLoaderArgs);
    expect(detail.capture).not.toBeNull();

    const html = renderToStaticMarkup(<SubmissionDetailView {...detail} />);
    expect(html).toContain("data-testid=\"capture-provenance\"");
    expect(html).toContain("Captured on the speaker");
    expect(html).toContain("nothing was sent to the speaker");

    // Must-not-fire control: an ordinary form submission has no banner.
    const ordinary = await detailLoader({
      request: await signedInGet(
        `https://x.test/admin/submissions/${fixture.abstractIds[0]}`,
        fixture.adminId,
      ),
      params: { id: fixture.abstractIds[0] },
      context: {},
    } as unknown as DetailLoaderArgs);
    expect(ordinary.capture).toBeNull();
    expect(renderToStaticMarkup(<SubmissionDetailView {...ordinary} />)).not.toContain(
      "capture-provenance",
    );
  });

  it("keeps the provenance block out of the public API's custom_fields", async () => {
    await capture({ pasted: "Private pitch text.", speakerEmail: "api@acme.test" });
    const captured = await capturedRow();
    expect((captured!.answers as Record<string, unknown>)[CAPTURE_KEY]).toBeDefined();

    const { serializeSession } = await import("~/lib/api/serialize");
    const json = serializeSession(
      {
        ...captured!,
        track: null,
        room: null,
        format: null,
        level: null,
        participants: [],
        tags: [],
        sourceCount: 0,
        composedInto: null,
        // The control: a real answer alongside the reserved key must survive.
        answers: { ...(captured!.answers as Record<string, unknown>), talk_title: "Real answer" },
      },
      { origin: "https://x.test" },
    );
    expect(json.custom_fields.map((entry) => entry.key)).toEqual(["talk_title"]);
  });
});
