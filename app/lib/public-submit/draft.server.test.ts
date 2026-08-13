/**
 * The submit path's people-writing rules.
 *
 * The Biography box on the wizard's Participant step is the SAME field as the
 * portal profile's bio. An authenticated submitter may fill their own blank
 * profile, and a brand-new participant can receive initial defaults. Naming an
 * existing account as a co-speaker is not proof of control, though, so it must
 * never mutate that account's global profile. Each direction is tested here.
 */
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  eventPeople,
  events,
  forms,
  people,
  sessionParticipants,
  sessionRevisions,
  sessions,
} from "~/db/schema";
import { createLoginSession } from "~/lib/auth/auth.server";
import { selectRecipients } from "~/lib/comms/bulk";
import { loadComposeRecipients } from "~/lib/comms/bulk.server";
import { loader as adminTasksLoader } from "~/routes/admin.tasks";
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

/**
 * The event role a submit confers.
 *
 * `admin.reviews` provisions a brand-new reviewer with `event_role = "reviewer"`
 * — a legibility label, since `is_reviewer` is what actually carries the
 * capability. But every speaker-scoped surface in the product filters
 * `event_role = "speaker"` BY EQUALITY: `speakerRoster()` in admin.tasks, and
 * each audience in comms/bulk. So a reviewer who then submitted a talk of their
 * own stayed invisible as a speaker — unassignable as a task owner, and skipped
 * by all_speakers/accepted/pending/outstanding_tasks/track, which includes their
 * own acceptance mail. The insert here used `onConflictDoNothing()`, so the
 * pre-existing row's label never moved.
 *
 * Submitting is the act that makes someone a speaker, so this is where the label
 * is corrected — and ONLY from the two labels that mean "not yet a speaker".
 * An organizer stays an organizer, and `is_reviewer` survives untouched: it is
 * additive on purpose, and clobbering it would silently revoke a review
 * assignment as a side effect of the person submitting a talk.
 */
describe("submitDraft — event role on submit", () => {
  const soloSpeaker = (
    email: string,
    firstName: string,
    lastName: string,
  ): DraftView["participants"] => [
    { role: "speaker", firstName, lastName, email, bio: "", isPrimary: true, answers: {} },
  ];

  /** A membership shaped the way admin.reviews provisioning shapes one. */
  async function provision(email: string, eventRole: string, isReviewer: boolean) {
    const personId = crypto.randomUUID();
    await ctx.db.insert(people).values({ id: personId, email, fullName: "Ingrid Nandal" });
    await ctx.db
      .insert(eventPeople)
      .values({ eventId: EVENT_ID, personId, eventRole, isReviewer });
    return personId;
  }

  const membershipOf = (personId: string) =>
    ctx.db.query.eventPeople.findFirst({
      where: and(eq(eventPeople.eventId, EVENT_ID), eq(eventPeople.personId, personId)),
    });

  /** The task-assignee roster, read through the real admin loader. */
  async function rosterEmails(): Promise<string[]> {
    const url = "https://x.test/admin/tasks";
    const cookie = (await createLoginSession(new Request(url), fixture.adminId)).split(";")[0];
    const loaded = await adminTasksLoader({
      request: new Request(url, { headers: { cookie } }),
      params: {},
      context: {},
    } as never);
    return loaded.roster.map((person) => person.email);
  }

  /** The bulk-comms audience, read through the real recipient loader. */
  async function allSpeakerEmails(): Promise<string[]> {
    const candidates = await loadComposeRecipients({ eventId: EVENT_ID, db: ctx.db });
    return selectRecipients(candidates, "all_speakers").map((person) => person.email);
  }

  it("must fire: a reviewer who submits reaches the speaker roster and the all_speakers audience", async () => {
    const email = "ingrid.nandal@example.com";
    const personId = await provision(email, "reviewer", true);

    // The premise, measured rather than assumed: both surfaces skip them first.
    expect(await rosterEmails()).not.toContain(email);
    expect(await allSpeakerEmails()).not.toContain(email);

    const result = await submit(personId, soloSpeaker(email, "Ingrid", "Nandal"));
    expect(result.ok).toBe(true);

    expect((await membershipOf(personId))?.eventRole).toBe("speaker");
    expect(await rosterEmails()).toContain(email);
    expect(await allSpeakerEmails()).toContain(email);
  });

  it("must fire: a contact-role membership upgrades on submit too", async () => {
    const email = "casey.contact@example.com";
    const personId = await provision(email, "contact", false);

    const result = await submit(personId, soloSpeaker(email, "Casey", "Contact"));
    expect(result.ok).toBe(true);

    expect((await membershipOf(personId))?.eventRole).toBe("speaker");
    expect(await allSpeakerEmails()).toContain(email);
  });

  it("must NOT fire: the is_reviewer capability survives the upgrade", async () => {
    const email = "ingrid.nandal@example.com";
    const personId = await provision(email, "reviewer", true);

    await submit(personId, soloSpeaker(email, "Ingrid", "Nandal"));

    const membership = await membershipOf(personId);
    expect(membership?.eventRole).toBe("speaker");
    expect(membership?.isReviewer).toBe(true);
  });

  it.each(["organizer", "admin"])(
    "must NOT fire: a submitting %s keeps their role and stays out of the speaker audience",
    async (eventRole) => {
      const email = `${eventRole}.submitter@example.com`;
      const personId = await provision(email, eventRole, false);

      const result = await submit(personId, soloSpeaker(email, "Robin", "Harlow"));
      expect(result.ok).toBe(true);

      expect((await membershipOf(personId))?.eventRole).toBe(eventRole);
      expect(await allSpeakerEmails()).not.toContain(email);
    },
  );

  it("must NOT fire: an existing speaker's membership row is left byte-for-byte alone", async () => {
    // A speaker who also agreed to review — the additive shape, from the other
    // side. Nothing about submitting again may disturb it.
    const personId = fixture.speakerIds[0];
    await ctx.db
      .update(eventPeople)
      .set({ isReviewer: true })
      .where(and(eq(eventPeople.eventId, EVENT_ID), eq(eventPeople.personId, personId)));
    const before = await membershipOf(personId);

    await submit(personId, soloSpeaker("speaker@callboard.dev", "Sam", "Speaker"));

    expect(await membershipOf(personId)).toEqual(before);
  });
});
