/**
 * The submit path's people-writing rules.
 *
 * The Biography box on the wizard's Participant step is the SAME field as the
 * portal profile's bio. An authenticated submitter may fill their own blank
 * profile, and a brand-new participant can receive initial defaults. Naming an
 * existing account as a co-speaker is not proof of control, though, so it must
 * never mutate that account's global profile. Each direction is tested here.
 */
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  events,
  forms,
  people,
  sessionParticipants,
  sessionRevisions,
  sessions,
} from "~/db/schema";
import { installTestDb, type TestDbContext } from "~/test/db";
import { CFP_FORM_ID, EVENT_ID, seedDemoFixture, type DemoFixture } from "~/test/fixtures";

import { submitDraft, type DraftView, type SubmitResult } from "./draft.server";
import { toFormDefinition } from "./contract";

let ctx: TestDbContext;
let fixture: DemoFixture;

beforeEach(async () => {
  ctx = installTestDb();
  fixture = await seedDemoFixture(ctx.db);
});
afterEach(() => ctx.close());

/** A draft owned by `personId`, ready for submitDraft(). */
async function makeDraft(personId: string, participants: DraftView["participants"]) {
  const id = crypto.randomUUID();
  await ctx.db.insert(sessions).values({
    id,
    eventId: EVENT_ID,
    formId: CFP_FORM_ID,
    title: "A draft in progress",
    status: "draft",
    isAbstract: true,
    answers: { fields: { title: "A draft in progress" }, participants, __content: {} },
  });
  await ctx.db
    .insert(sessionParticipants)
    .values({ sessionId: id, personId, role: "speaker", isPrimary: true, order: 0 });

  return {
    id,
    status: "draft",
    title: "A draft in progress",
    fields: { title: "A draft in progress", abstract: "Body." },
    participants,
    content: {
      mode: "abstract" as const,
      videoUrl: "",
      uploadKey: null,
      uploadName: null,
      uploadSize: null,
    },
  } satisfies DraftView;
}

async function submit(personId: string, participants: DraftView["participants"]) {
  const draft = await makeDraft(personId, participants);
  const event = await ctx.db.query.events.findFirst({ where: eq(events.id, EVENT_ID) });
  const form = await ctx.db.query.forms.findFirst({ where: eq(forms.id, CFP_FORM_ID) });
  const submitter = await ctx.db.query.people.findFirst({ where: eq(people.id, personId) });

  return submitDraft({
    request: new Request("https://x.test/submit"),
    event: event!,
    form: form!,
    def: toFormDefinition(form!),
    draft,
    submitter: submitter!,
  });
}

const bioOf = async (id: string) =>
  (await ctx.db.query.people.findFirst({ where: eq(people.id, id) }))?.bio ?? null;

describe("submitDraft — participant biography", () => {
  it("must fire: fills a blank profile bio from the wizard's Biography box", async () => {
    // Speaker 6 is seeded with no bio on purpose.
    const blank = fixture.speakerIds[6];
    expect(await bioOf(blank)).toBeNull();

    const result = await submit(blank, [
      {
        role: "speaker",
        firstName: "Jonas",
        lastName: "Weir",
        email: "jonas@example.com",
        bio: "Leads data at Griffin. Typed this while submitting.",
        isPrimary: true,
        answers: {},
      },
    ]);

    expect(result.ok).toBe(true);
    expect(await bioOf(blank)).toBe("Leads data at Griffin. Typed this while submitting.");
  });

  it("must fire: cannot fill an existing co-speaker's blank global profile", async () => {
    // Speaker 6 is seeded with no bio. Another submitter merely naming that
    // address as a participant must not gain write authority over the profile.
    const blank = fixture.speakerIds[6];
    expect(await bioOf(blank)).toBeNull();

    const result = await submit(fixture.speakerIds[0], [
      {
        role: "speaker",
        firstName: "Sam",
        lastName: "Speaker",
        email: "speaker@callboard.dev",
        bio: "",
        isPrimary: true,
        answers: {},
      },
      {
        role: "co_speaker",
        firstName: "Jonas",
        lastName: "Weir",
        email: "jonas@example.com",
        bio: "Attacker-controlled global profile text.",
        isPrimary: false,
        answers: {},
      },
    ]);

    expect(result.ok).toBe(true);
    expect(await bioOf(blank)).toBeNull();
  });

  it("must NOT fire: a bio the speaker already wrote is never overwritten", async () => {
    const existing = fixture.speakerIds[0];
    const before = await bioOf(existing);
    expect(before).toBeTruthy();

    await submit(existing, [
      {
        role: "speaker",
        firstName: "Sam",
        lastName: "Speaker",
        email: "speaker@callboard.dev",
        bio: "A DIFFERENT bio typed into the wizard.",
        isPrimary: true,
        answers: {},
      },
    ]);

    expect(await bioOf(existing)).toBe(before);
  });

  it("must NOT fire: a blank Biography box does not blank an existing bio", async () => {
    const existing = fixture.speakerIds[1];
    const before = await bioOf(existing);

    await submit(existing, [
      {
        role: "speaker",
        firstName: "Rina",
        lastName: "Okafor",
        email: "rina@example.com",
        bio: "   ",
        isPrimary: true,
        answers: {},
      },
    ]);

    expect(await bioOf(existing)).toBe(before);
  });

  it("still writes the bio for a person it has never seen", async () => {
    const result = await submit(fixture.speakerIds[0], [
      {
        role: "speaker",
        firstName: "Sam",
        lastName: "Speaker",
        email: "speaker@callboard.dev",
        bio: "",
        isPrimary: true,
        answers: {},
      },
      {
        role: "co_speaker",
        firstName: "Brand",
        lastName: "New",
        email: "brand-new@example.com",
        bio: "Never been in this database before.",
        isPrimary: false,
        answers: {},
      },
    ]);

    expect(result.ok).toBe(true);
    const created = await ctx.db.query.people.findFirst({
      where: eq(people.email, "brand-new@example.com"),
    });
    expect(created?.bio).toBe("Never been in this database before.");
  });
});

/**
 * The submit is the FIRST entry in a session's change history — the row every
 * later "Organizer edit" and "Restored" entry is measured against. submitDraft
 * writes it inside the same atomic batch as the status flip.
 *
 * This is the control that guards that write: deleting the
 * `db.insert(sessionRevisions)` block in submitDraft leaves `npm run check`
 * green everywhere else, because nothing else reads the row. It does not leave
 * THIS green — every assertion below fails without the insert.
 */
describe("submitDraft — CFP submit revision", () => {
  const revisionsFor = (sessionId: string) =>
    ctx.db.select().from(sessionRevisions).where(eq(sessionRevisions.sessionId, sessionId));

  it("must fire: a public submit records a source:'submit' revision attributed to the submitter with the submitted content", async () => {
    const submitter = fixture.speakerIds[0];
    const result = await submit(submitter, [
      {
        role: "speaker",
        firstName: "Sam",
        lastName: "Speaker",
        email: "speaker@callboard.dev",
        bio: "",
        isPrimary: true,
        answers: {},
      },
    ]);

    expect(result.ok).toBe(true);
    // A brand-new draft: the only revision on it can be the submit itself.
    const sessionId = (result as Extract<SubmitResult, { ok: true }>).sessionId;
    const revisions = await revisionsFor(sessionId);
    expect(revisions).toHaveLength(1);

    // Values, not shapes: attribution is the submitter, the source names the
    // action, and the content is exactly what the row was submitted with.
    const [revision] = revisions;
    expect(revision.source).toBe("submit");
    expect(revision.editorPersonId).toBe(submitter);
    expect(revision.editorName).toBe("Sam Speaker");
    expect(revision.title).toBe("A draft in progress");
    expect(revision.description).toBe("Body.");
  });
});
