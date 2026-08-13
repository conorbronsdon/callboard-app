import { renderToStaticMarkup } from "react-dom/server";
import { and, eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  contactNotes,
  contactTags,
  eventPeople,
  events,
  people,
  pipelineEntries,
  stageTransitions,
} from "~/db/schema";
import { enrollContact, loadPipelineForPerson, moveEntry } from "~/lib/pipeline.server";
import { signedInGet, signedInPost } from "~/test/auth";
import { installTestDb, type TestDbContext } from "~/test/db";
import { seedDemoFixture, type DemoFixture } from "~/test/fixtures";

import {
  ContactsScreen,
  action as contactsAction,
  loader as contactsLoader,
  type ContactsData,
} from "./admin.contacts";
import {
  ContactDetailScreen,
  action as detailAction,
  loader as detailLoader,
  type ContactDetailData,
} from "./admin.contacts.detail";
import { loader as portalLoader } from "./portal.index";
import { loader as publicSpeakersLoader } from "./public.speakers";

type ContactsLoaderArgs = Parameters<typeof contactsLoader>[0];
type ContactsActionArgs = Parameters<typeof contactsAction>[0];
type DetailLoaderArgs = Parameters<typeof detailLoader>[0];
type DetailActionArgs = Parameters<typeof detailAction>[0];

const BASE = "https://x.test/admin/contacts";
const asContactsLoaderArgs = (request: Request) =>
  ({ request, params: {}, context: {} }) as unknown as ContactsLoaderArgs;
const asContactsActionArgs = (request: Request) =>
  ({ request, params: {}, context: {} }) as unknown as ContactsActionArgs;
const asDetailLoaderArgs = (request: Request, id: string) =>
  ({ request, params: { id }, context: {} }) as unknown as DetailLoaderArgs;
const asDetailActionArgs = (request: Request, id: string) =>
  ({ request, params: { id }, context: {} }) as unknown as DetailActionArgs;

let ctx: TestDbContext;
let fixture: DemoFixture;

beforeEach(async () => {
  ctx = installTestDb();
  fixture = await seedDemoFixture(ctx.db);
});
afterEach(() => ctx.close());

async function loadContacts(query = ""): Promise<ContactsData> {
  return contactsLoader(
    asContactsLoaderArgs(await signedInGet(`${BASE}${query}`, fixture.adminId)),
  );
}

async function postContacts(fields: Record<string, string>) {
  return contactsAction(
    asContactsActionArgs(await signedInPost(BASE, fixture.adminId, fields)),
  );
}

async function loadDetail(id: string): Promise<ContactDetailData> {
  return detailLoader(
    asDetailLoaderArgs(await signedInGet(`${BASE}/${id}`, fixture.adminId), id),
  );
}

async function postDetail(id: string, fields: Record<string, string>) {
  return detailAction(
    asDetailActionArgs(await signedInPost(`${BASE}/${id}`, fixture.adminId, fields), id),
  );
}

async function addEvent(id: string, name: string, slug: string) {
  await ctx.db.insert(events).values({ id, name, slug, timezone: "UTC" });
}

describe("contacts loader", () => {
  it("MUST FIRE: one email stays one row when the person belongs to two events", async () => {
    await addEvent("event-two", "Second Event", "second-event");
    await ctx.db.insert(eventPeople).values({
      eventId: "event-two",
      personId: fixture.speakerIds[0],
      eventRole: "speaker",
    });

    const data = await loadContacts();
    const matches = data.contacts.filter((row) => row.email === "speaker@callboard.dev");
    expect(matches).toHaveLength(1);
    expect(matches[0].eventsCount).toBe(2);
  });

  it("MUST NOT FIRE: a shared full name does not dedupe distinct emails", async () => {
    await ctx.db.insert(people).values([
      { id: "same-name-a", email: "alex.a@example.com", fullName: "Alex Lee" },
      { id: "same-name-b", email: "alex.b@example.com", fullName: "Alex Lee" },
    ]);
    const data = await loadContacts();
    expect(data.contacts.filter((row) => row.fullName === "Alex Lee")).toHaveLength(2);
  });

  it("includes a global contact with no event membership", async () => {
    await ctx.db.insert(people).values({
      id: "unbound",
      email: "unbound@example.com",
      fullName: "Una Bound",
    });
    expect((await loadContacts()).contacts.some((row) => row.id === "unbound")).toBe(true);
  });

  it("filters by company and a value matching nothing returns no rows", async () => {
    const company = await loadContacts("?company=Company%200");
    expect(company.contacts.map((row) => row.company)).toEqual(["Company 0"]);
    /*
     * The empty case is driven by SEARCH, not by `?company=Nope`.
     *
     * A company that is not in the directory's own company list can only have
     * arrived from a stale link — a saved segment, a bookmark — and CRM-09 drops
     * such a term and says so rather than filtering on a value the <select>
     * beside it cannot even display (see admin.contacts.segments.test.tsx).
     * Free text has no vocabulary to fall out of, so it still returns nothing.
     */
    expect((await loadContacts("?q=nobody-by-that-name")).contacts).toEqual([]);
  });

  it("event=multi returns only contacts attached to two or more events", async () => {
    await addEvent("event-two", "Second Event", "second-event");
    await ctx.db.insert(eventPeople).values({
      eventId: "event-two",
      personId: fixture.speakerIds[1],
      eventRole: "speaker",
    });
    const data = await loadContacts("?event=multi");
    expect(data.contacts.map((row) => row.id)).toEqual([fixture.speakerIds[1]]);
  });

  it("notes=with returns only contacts with an internal note", async () => {
    await ctx.db.insert(contactNotes).values({
      id: "note-filter",
      personId: fixture.speakerIds[2],
      authorId: fixture.adminId,
      body: "Known from the community dinner.",
    });
    const data = await loadContacts("?notes=with");
    expect(data.contacts.map((row) => row.id)).toEqual([fixture.speakerIds[2]]);
  });
});

describe("CSV import", () => {
  it("MUST FIRE: imports two contacts that are immediately listed", async () => {
    const result = await postContacts({
      intent: "import-commit",
      rawCsv: "name,email,company,title\nNew One,new.one@example.com,North,Engineer\nNew Two,new.two@example.com,South,Director",
    });
    expect(result).toMatchObject({ ok: true });
    const emails = (await loadContacts()).contacts.map((row) => row.email);
    expect(emails).toContain("new.one@example.com");
    expect(emails).toContain("new.two@example.com");
  });

  it("MUST NOT FIRE: import creates no event memberships", async () => {
    const before = await ctx.db.select({ n: sql<number>`count(*)` }).from(eventPeople);
    await postContacts({
      intent: "import-commit",
      rawCsv: "name,email\nUnbound Contact,unbound.csv@example.com",
    });
    const after = await ctx.db.select({ n: sql<number>`count(*)` }).from(eventPeople);
    expect(after[0].n).toBe(before[0].n);
  });

  it("MUST NOT FIRE: one malformed email refuses the whole CSV", async () => {
    const result = await postContacts({
      intent: "import-commit",
      rawCsv: "name,email\nGood Row,good-row@example.com\nBad Row,not-an-email",
    });
    expect(result).toMatchObject({ ok: false });
    expect(
      await ctx.db.query.people.findFirst({ where: eq(people.email, "good-row@example.com") }),
    ).toBeUndefined();
  });
});

describe("add to event", () => {
  it("MUST FIRE: adds membership and increments the directory count", async () => {
    await addEvent("event-two", "Second Event", "second-event");
    const id = fixture.speakerIds[0];
    expect((await loadContacts()).contacts.find((row) => row.id === id)?.eventsCount).toBe(1);
    expect(await postContacts({ intent: "add-to-event", personId: id, eventId: "event-two" })).toMatchObject({ ok: true });
    expect((await loadContacts()).contacts.find((row) => row.id === id)?.eventsCount).toBe(2);
  });

  it("MUST NOT FIRE: an unknown event writes nothing", async () => {
    const before = await ctx.db.select({ n: sql<number>`count(*)` }).from(eventPeople);
    expect(await postContacts({ intent: "add-to-event", personId: fixture.speakerIds[0], eventId: "missing" })).toMatchObject({ ok: false });
    const after = await ctx.db.select({ n: sql<number>`count(*)` }).from(eventPeople);
    expect(after[0].n).toBe(before[0].n);
  });

  it("MUST NOT FIRE: reposting a pair does not duplicate membership", async () => {
    const id = fixture.speakerIds[0];
    await postContacts({ intent: "add-to-event", personId: id, eventId: fixture.eventId });
    const rows = await ctx.db
      .select()
      .from(eventPeople)
      .where(and(eq(eventPeople.eventId, fixture.eventId), eq(eventPeople.personId, id)));
    expect(rows).toHaveLength(1);
  });
});

describe("contact detail", () => {
  it("MUST FIRE: lists both attached events and MUST NOT list an unattached event", async () => {
    await addEvent("event-two", "Second Event", "second-event");
    await addEvent("event-three", "Third Event", "third-event");
    await ctx.db.insert(eventPeople).values({
      eventId: "event-two",
      personId: fixture.speakerIds[0],
      eventRole: "speaker",
    });
    const data = await loadDetail(fixture.speakerIds[0]);
    expect(data.events.map((row) => row.eventName)).toEqual(expect.arrayContaining([
      "Frontier AI Summit 2026",
      "Second Event",
    ]));
    expect(data.events.map((row) => row.eventName)).not.toContain("Third Event");
  });

  it("MUST FIRE: adds a note with the signed-in author's name", async () => {
    const id = fixture.speakerIds[0];
    expect(await postDetail(id, { intent: "add-note", body: "Invite for the keynote dinner." })).toMatchObject({ ok: true });
    expect((await loadDetail(id)).notes[0]).toMatchObject({
      body: "Invite for the keynote dinner.",
      authorName: "Ada Organiser",
    });
  });

  it("MUST NOT FIRE: blank notes are refused without a write", async () => {
    const id = fixture.speakerIds[0];
    expect(await postDetail(id, { intent: "add-note", body: "   " })).toMatchObject({ ok: false });
    expect((await loadDetail(id)).notes).toEqual([]);
  });
});

describe("duplicate surfacing and merge", () => {
  it("MUST FIRE: moves memberships and notes, tombstones the loser, and hides it", async () => {
    await ctx.db.insert(people).values([
      { id: "merge-winner", email: "ingrid@example.com", fullName: "Ingrid Rao" },
      { id: "merge-loser", email: "ingrid.r@example.com", fullName: "Ingrid Rao" },
    ]);
    await ctx.db.insert(eventPeople).values({ eventId: fixture.eventId, personId: "merge-loser" });
    await ctx.db.insert(contactNotes).values({ id: "merge-note", personId: "merge-loser", authorId: fixture.adminId, body: "Invite to the keynote dinner." });

    expect(await postContacts({ intent: "merge", primaryId: "merge-winner", duplicateId: "merge-loser" })).toMatchObject({ ok: true });
    expect((await loadDetail("merge-winner")).notes.map((row) => row.body)).toContain("Invite to the keynote dinner.");
    expect((await ctx.db.query.people.findFirst({ where: eq(people.id, "merge-loser") }))?.mergedInto).toBe("merge-winner");
    expect((await loadContacts()).contacts.some((row) => row.id === "merge-loser")).toBe(false);
    expect(await ctx.db.select().from(eventPeople).where(and(eq(eventPeople.eventId, fixture.eventId), eq(eventPeople.personId, "merge-winner")))).toHaveLength(1);
  });

  it("MUST FIRE: removes a colliding event membership before moving the loser", async () => {
    await ctx.db.insert(people).values([
      { id: "collision-winner", email: "alex.one@example.com", fullName: "Alex One" },
      { id: "collision-loser", email: "alex.two@example.com", fullName: "Alex One" },
    ]);
    await ctx.db.insert(eventPeople).values([
      { eventId: fixture.eventId, personId: "collision-winner" },
      { eventId: fixture.eventId, personId: "collision-loser" },
    ]);
    const before = await ctx.db.select({ count: sql<number>`count(*)` }).from(eventPeople).where(eq(eventPeople.eventId, fixture.eventId));
    expect(await postContacts({ intent: "merge", primaryId: "collision-winner", duplicateId: "collision-loser" })).toMatchObject({ ok: true });
    const after = await ctx.db.select({ count: sql<number>`count(*)` }).from(eventPeople).where(eq(eventPeople.eventId, fixture.eventId));
    expect(after[0].count).toBe(before[0].count - 1);
    expect(await ctx.db.select().from(eventPeople).where(and(eq(eventPeople.eventId, fixture.eventId), eq(eventPeople.personId, "collision-winner")))).toHaveLength(1);
  });

  it("MUST NOT FIRE: rejects self, unknown, and already-merged contacts without writes", async () => {
    const id = fixture.speakerIds[0];
    expect(await postContacts({ intent: "merge", primaryId: id, duplicateId: id })).toMatchObject({ ok: false, error: "A contact cannot be merged into itself." });
    expect((await ctx.db.query.people.findFirst({ where: eq(people.id, id) }))?.mergedInto).toBeNull();
    expect(await postContacts({ intent: "merge", primaryId: id, duplicateId: "unknown" })).toMatchObject({ ok: false });
    expect((await ctx.db.query.people.findFirst({ where: eq(people.id, id) }))?.mergedInto).toBeNull();
    await ctx.db.update(people).set({ mergedInto: id }).where(eq(people.id, fixture.speakerIds[1]));
    expect(await postContacts({ intent: "merge", primaryId: id, duplicateId: fixture.speakerIds[1] })).toMatchObject({ ok: false });
    expect((await ctx.db.query.people.findFirst({ where: eq(people.id, id) }))?.mergedInto).toBeNull();
  });

  it("MUST NOT FIRE: keeps a populated winner profile value", async () => {
    await ctx.db.insert(people).values([
      { id: "profile-winner", email: "winner@example.com", fullName: "Profile Pair", company: "Winner Co" },
      { id: "profile-loser", email: "loser@example.com", fullName: "Profile Pair", company: "Loser Co" },
    ]);
    await postContacts({ intent: "merge", primaryId: "profile-winner", duplicateId: "profile-loser" });
    expect((await ctx.db.query.people.findFirst({ where: eq(people.id, "profile-winner") }))?.company).toBe("Winner Co");
  });

  it("MUST FIRE: clears the loser's adopted headshot and consent after merge", async () => {
    await ctx.db.insert(people).values([
      { id: "photo-winner", email: "photo.winner@example.com", fullName: "Photo Pair" },
      {
        id: "photo-loser",
        email: "photo.loser@example.com",
        fullName: "Photo Pair",
        headshotKey: "uploads/loser-face.png",
        photoPublishable: true,
      },
    ]);

    await postContacts({ intent: "merge", primaryId: "photo-winner", duplicateId: "photo-loser" });

    const winner = await ctx.db.query.people.findFirst({ where: eq(people.id, "photo-winner") });
    const loser = await ctx.db.query.people.findFirst({ where: eq(people.id, "photo-loser") });
    expect(winner?.headshotKey).toBe("uploads/loser-face.png");
    expect(winner?.photoPublishable).toBe(true);
    expect(loser?.headshotKey).toBeNull();
    expect(loser?.photoPublishable).toBe(false);
  });

  it("MUST NOT FIRE: keeps the winner's headshot when the loser has none", async () => {
    // A blanket cleanup must clear only the tombstone, never the surviving photo.
    await ctx.db.insert(people).values([
      {
        id: "own-photo-winner",
        email: "own.photo.winner@example.com",
        fullName: "Own Photo Pair",
        headshotKey: "uploads/winner-face.png",
        photoPublishable: true,
      },
      { id: "no-photo-loser", email: "no.photo.loser@example.com", fullName: "Own Photo Pair" },
    ]);

    await postContacts({ intent: "merge", primaryId: "own-photo-winner", duplicateId: "no-photo-loser" });

    const winner = await ctx.db.query.people.findFirst({ where: eq(people.id, "own-photo-winner") });
    const loser = await ctx.db.query.people.findFirst({ where: eq(people.id, "no-photo-loser") });
    expect(winner?.headshotKey).toBe("uploads/winner-face.png");
    expect(winner?.photoPublishable).toBe(true);
    expect(loser?.headshotKey).toBeNull();
    expect(loser?.photoPublishable).toBe(false);
  });

  it("MUST FIRE and MUST NOT FIRE: flags only repeated normalized names", async () => {
    await ctx.db.insert(people).values([
      { id: "dup-a", email: "dup.a@example.com", fullName: "Casey Kim" },
      { id: "dup-b", email: "dup.b@example.com", fullName: "  CASEY KIM  " },
      { id: "single", email: "single@example.com", fullName: "Solo Name" },
    ]);
    const data = await loadContacts();
    expect(data.duplicateGroups).toHaveLength(1);
    expect(data.duplicateGroups[0].contacts.map((row) => row.id)).toEqual(["dup-b", "dup-a"]);
    expect(data.contacts.find((row) => row.id === "dup-a")?.possibleDuplicate).toBe(true);
    expect(data.contacts.find((row) => row.id === "single")?.possibleDuplicate).toBe(false);
  });

  it("refuses writes to a merged detail record", async () => {
    const id = fixture.speakerIds[1];
    await ctx.db.update(people).set({ mergedInto: fixture.speakerIds[0] }).where(eq(people.id, id));
    expect(await postDetail(id, { intent: "add-note", body: "Should not save" })).toMatchObject({ ok: false, error: "This contact was merged into another record." });
    expect(await postDetail(id, { intent: "add-to-event", eventId: fixture.eventId })).toMatchObject({ ok: false, error: "This contact was merged into another record." });
  });

  /*
   * MERGE MUST CARRY THE SOURCING PIPELINE.
   *
   * `pipeline_entries` and `stage_transitions` are person-keyed, and every
   * pipeline surface reads them through the SURVIVOR's id: `loadBoard` inner-
   * joins `people` and drops tombstoned rows, `loadPipelineForPerson` filters on
   * `person_id`. A merge that reassigns memberships but not these two tables
   * therefore does not "leave the entry behind" — it destroys the contact's
   * stage, score, rationale, and audit trail on every screen that can show them.
   */
  async function enrollFor(
    personId: string,
    { stage, score, rationale }: { stage: string; score: number; rationale: string },
  ) {
    const result = await enrollContact(ctx.db, {
      personId,
      stage,
      score,
      rationale,
      movedByPersonId: fixture.adminId,
    });
    expect(result).toMatchObject({ ok: true });
    return result.ok ? result.entryId : "";
  }

  const stagesUnder = async (personId: string) =>
    (await loadPipelineForPerson(ctx.db, personId)).transitions
      .map((row) => row.toStage)
      .sort();

  it("MUST FIRE: the loser's sourcing entry and its whole stage history follow the survivor", async () => {
    await ctx.db.insert(people).values([
      { id: "pipe-winner", email: "nadia@example.com", fullName: "Nadia Okafor" },
      { id: "pipe-loser", email: "nadia.o@example.com", fullName: "Nadia Okafor" },
    ]);
    const loserEntryId = await enrollFor("pipe-loser", {
      stage: "prospect",
      score: 61,
      rationale: "Met at the sourcing dinner.",
    });
    expect(
      await moveEntry(ctx.db, { entryId: loserEntryId, toStage: "contacted", movedByPersonId: fixture.adminId }),
    ).toMatchObject({ ok: true, moved: true });
    expect(await ctx.db.select().from(stageTransitions).where(eq(stageTransitions.personId, "pipe-loser"))).toHaveLength(2);

    expect(await postContacts({ intent: "merge", primaryId: "pipe-winner", duplicateId: "pipe-loser" })).toMatchObject({ ok: true });

    const survivor = await loadPipelineForPerson(ctx.db, "pipe-winner");
    expect(survivor.entry).toMatchObject({
      entryId: loserEntryId,
      stage: "contacted",
      score: 61,
      rationale: "Met at the sourcing dinner.",
    });
    expect(await stagesUnder("pipe-winner")).toEqual(["contacted", "prospect"]);
    // The surface the organizer actually looks at, not just the row underneath it.
    expect((await loadDetail("pipe-winner")).pipeline?.entry?.stage).toBe("contacted");

    const loser = await loadPipelineForPerson(ctx.db, "pipe-loser");
    expect(loser.entry).toBeNull();
    expect(loser.transitions).toEqual([]);
  });

  it("MUST FIRE: both enrolled - the survivor's own stage and score win and the loser's entry is dropped", async () => {
    await ctx.db.insert(people).values([
      { id: "both-winner", email: "sam@example.com", fullName: "Sam Vale" },
      { id: "both-loser", email: "sam.v@example.com", fullName: "Sam Vale" },
    ]);
    const winnerEntryId = await enrollFor("both-winner", {
      stage: "confirmed",
      score: 90,
      rationale: "Winner rationale.",
    });
    const loserEntryId = await enrollFor("both-loser", {
      stage: "prospect",
      score: 12,
      rationale: "Loser rationale.",
    });
    await moveEntry(ctx.db, { entryId: loserEntryId, toStage: "declined", movedByPersonId: fixture.adminId });

    expect(await postContacts({ intent: "merge", primaryId: "both-winner", duplicateId: "both-loser" })).toMatchObject({ ok: true });

    const survivor = await loadPipelineForPerson(ctx.db, "both-winner");
    expect(survivor.entry).toMatchObject({
      entryId: winnerEntryId,
      stage: "confirmed",
      score: 90,
      rationale: "Winner rationale.",
    });
    // One entry per person is an invariant (`pipeline_entries_person_idx`), so
    // the loser's row is deleted rather than re-pointed onto a taken slot.
    expect(await ctx.db.select().from(pipelineEntries).where(eq(pipelineEntries.id, loserEntryId))).toHaveLength(0);
    expect(await ctx.db.select().from(pipelineEntries).where(eq(pipelineEntries.personId, "both-winner"))).toHaveLength(1);
    // History is append-only: the dropped entry's transitions still survive
    // under the survivor (`stage_transitions.entry_id` has no FK by design).
    expect(await stagesUnder("both-winner")).toEqual(["confirmed", "declined", "prospect"]);
    expect(await ctx.db.select().from(stageTransitions).where(eq(stageTransitions.personId, "both-loser"))).toHaveLength(0);
  });

  it("MUST NOT FIRE: a merge with no pipeline involvement still moves records and invents no entry", async () => {
    await ctx.db.insert(people).values([
      { id: "plain-winner", email: "iris@example.com", fullName: "Iris Bell" },
      { id: "plain-loser", email: "iris.b@example.com", fullName: "Iris Bell" },
    ]);
    await ctx.db.insert(eventPeople).values({ eventId: fixture.eventId, personId: "plain-loser" });
    await ctx.db.insert(contactNotes).values({ id: "plain-note", personId: "plain-loser", authorId: fixture.adminId, body: "No pipeline here." });

    expect(await postContacts({ intent: "merge", primaryId: "plain-winner", duplicateId: "plain-loser" })).toMatchObject({ ok: true });

    expect((await loadDetail("plain-winner")).notes.map((row) => row.body)).toContain("No pipeline here.");
    expect(await ctx.db.select().from(eventPeople).where(and(eq(eventPeople.eventId, fixture.eventId), eq(eventPeople.personId, "plain-winner")))).toHaveLength(1);
    expect((await ctx.db.query.people.findFirst({ where: eq(people.id, "plain-loser") }))?.mergedInto).toBe("plain-winner");
    for (const id of ["plain-winner", "plain-loser"]) {
      expect(await ctx.db.select().from(pipelineEntries).where(eq(pipelineEntries.personId, id))).toHaveLength(0);
      expect(await ctx.db.select().from(stageTransitions).where(eq(stageTransitions.personId, id))).toHaveLength(0);
    }
  });
});

describe("contact tags", () => {
  it("MUST FIRE: normalizes tags and filters by exact tag", async () => {
    const id = fixture.speakerIds[0];
    expect(await postDetail(id, { intent: "set-tags", tags: "Keynote Material, returning" })).toMatchObject({ ok: true });
    expect((await loadDetail(id)).tags).toEqual(["keynote-material", "returning"]);
    expect((await loadContacts("?tag=returning")).contacts.map((row) => row.id)).toContain(id);
    expect((await loadContacts("?tag=returning")).contacts.map((row) => row.id)).not.toContain(fixture.speakerIds[1]);
  });

  it("MUST NOT FIRE: rejects too many or too-long tags and preserves existing tags", async () => {
    const id = fixture.speakerIds[0];
    await postDetail(id, { intent: "set-tags", tags: "returning" });
    expect(await postDetail(id, { intent: "set-tags", tags: Array.from({ length: 13 }, (_, index) => `tag-${index}`).join(",") })).toMatchObject({ ok: false });
    expect((await loadDetail(id)).tags).toEqual(["returning"]);
    expect(await postDetail(id, { intent: "set-tags", tags: "x".repeat(41) })).toMatchObject({ ok: false });
    expect((await loadDetail(id)).tags).toEqual(["returning"]);
  });

  it("MUST NOT FIRE: re-saving deduped tags does not duplicate rows", async () => {
    const id = fixture.speakerIds[0];
    expect(await postDetail(id, { intent: "set-tags", tags: "returning, returning" })).toMatchObject({ ok: true });
    expect(await postDetail(id, { intent: "set-tags", tags: "returning" })).toMatchObject({ ok: true });
    expect(await ctx.db.select().from(contactTags).where(eq(contactTags.personId, id))).toHaveLength(1);
  });
});

describe("travel notes", () => {
  it("MUST FIRE: persists trimmed travel notes in the detail loader", async () => {
    const id = fixture.speakerIds[0];
    expect(await postDetail(id, { intent: "save-travel", travelNotes: "  Arrives Monday morning.  " })).toMatchObject({ ok: true });
    expect((await loadDetail(id)).contact?.travelNotes).toBe("Arrives Monday morning.");
  });

  it("MUST NOT FIRE: rejects 2001 characters and preserves the stored value", async () => {
    const id = fixture.speakerIds[0];
    await postDetail(id, { intent: "save-travel", travelNotes: "Keep this" });
    expect(await postDetail(id, { intent: "save-travel", travelNotes: "x".repeat(2001) })).toMatchObject({ ok: false });
    expect((await loadDetail(id)).contact?.travelNotes).toBe("Keep this");
  });
});

describe("contact stats", () => {
  it("MUST FIRE and MUST NOT FIRE: counts returning active contacts only", async () => {
    await addEvent("stats-event", "Stats Event", "stats-event");
    await ctx.db.insert(eventPeople).values([
      { eventId: "stats-event", personId: fixture.speakerIds[0] },
      { eventId: "stats-event", personId: fixture.speakerIds[1] },
    ]);
    await ctx.db.update(people).set({ mergedInto: fixture.speakerIds[0] }).where(eq(people.id, fixture.speakerIds[1]));
    const data = await loadContacts();
    expect(data.stats.returningContacts).toBe(1);
    expect(data.stats.totalContacts).toBe(8);
    expect(data.contacts.find((row) => row.id === fixture.speakerIds[2])?.eventsCount).toBe(1);
  });
});

describe("wire masking", () => {
  it("never sends internal note bodies through the speaker portal loader", async () => {
    const personId = fixture.speakerIds[0];
    const secret = "INTERNAL-ONLY keynote negotiation";
    await ctx.db.insert(contactNotes).values({
      id: "private-note",
      personId,
      authorId: fixture.adminId,
      body: secret,
    });
    const result = await portalLoader({
      request: await signedInGet("https://x.test/portal", personId),
      params: {},
      context: {},
    } as never);
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it("never sends travel notes through public speakers or the speaker portal", async () => {
    const personId = fixture.speakerIds[0];
    const secret = "PRIVATE TRAVEL WINDOW 7AM";
    await ctx.db.update(people).set({ travelNotes: secret }).where(eq(people.id, personId));
    const portal = await portalLoader({ request: await signedInGet("https://x.test/portal", personId), params: {}, context: {} } as never);
    const publicSpeakers = await publicSpeakersLoader({ request: new Request("https://x.test/e/frontier-ai-summit-2026/speakers"), params: { slug: "frontier-ai-summit-2026" }, context: {} } as never);
    expect(JSON.stringify(portal)).not.toContain(secret);
    expect(JSON.stringify(publicSpeakers)).not.toContain(secret);
  });
});

describe("render", () => {
  it("renders the directory controls and existing-profile reuse copy", async () => {
    const markup = renderToStaticMarkup(<ContactsScreen data={await loadContacts()} />);
    expect(markup).toContain('data-testid="contact-filters"');
    expect(markup).toContain('data-testid="contact-directory"');
    expect(markup).toContain('data-testid="contact-row-count"');
    expect(markup).toContain("reuses their existing profile");
  });

  it("renders the detail history, notes, and reuse copy", async () => {
    await addEvent("render-event", "Render Event", "render-event");
    const markup = renderToStaticMarkup(<ContactDetailScreen data={await loadDetail(fixture.speakerIds[0])} />);
    expect(markup).toContain('data-testid="contact-event-history"');
    expect(markup).toContain('data-testid="contact-notes"');
    expect(markup).toContain("the contact is not duplicated");
  });

  it("renders the directory and detail empty states", async () => {
    // Search, not `?company=Nope` — see the filter test above for why.
    const contacts = await loadContacts("?q=nobody-by-that-name");
    const directoryMarkup = renderToStaticMarkup(<ContactsScreen data={contacts} />);
    expect(directoryMarkup).toContain("No contacts match these filters");

    const missingMarkup = renderToStaticMarkup(
      <ContactDetailScreen
        data={{ contact: null, events: [], sessions: [], notes: [], tags: [], allEvents: [] }}
      />,
    );
    expect(missingMarkup).toContain("Contact not found");
  });
});

describe("saved segments and pipeline enroll coexist on one page", () => {
  /*
   * BLOCKER-1 guard. `/admin/contacts` is rewritten by two independent lanes:
   * saved segments (CRM-09) adds the segment chips plus save/delete forms, and
   * the sourcing pipeline (CRM-07) adds a per-row enroll form plus a SEPARATE
   * bulk-actions form the row checkboxes reach by `form=`. Git auto-merged the
   * two with no conflict marker, so nothing had proved they render together.
   * This renders one page carrying BOTH and asserts each feature's landmark
   * survives; a future merge that drops one, or nests the enroll form inside
   * the bulk form, goes red here.
   */
  it("MUST FIRE: a saved segment chip, the enroll form, and the intact bulk form all render together", async () => {
    const saved = await postContacts({
      intent: "save-segment",
      name: "Returning leads",
      querystring: "company=Company 1",
    });
    expect(saved).toMatchObject({ ok: true, intent: "save-segment" });

    const data = await loadContacts();
    // Non-vacuous: the enroll form only renders for an un-enrolled contact and
    // the chip only renders when a segment exists — prove both preconditions
    // before trusting the markup, so "reject/omit everything" cannot pass.
    expect(data.segments).toHaveLength(1);
    expect(data.contacts.some((contact) => contact.pipelineStage === null)).toBe(true);

    const markup = renderToStaticMarkup(<ContactsScreen data={data} />);
    // Segments (CRM-09) — the section, a chip, and the saved name.
    expect(markup).toContain('data-testid="contact-segments"');
    expect(markup).toContain('data-testid="contact-segment"');
    expect(markup).toContain("Returning leads");
    // Pipeline enroll (CRM-07) — the per-row form's submit intent and label.
    expect(markup).toContain('value="enroll"');
    expect(markup).toContain("Score for");
    // Bulk actions form intact and SEPARATE — the enroll form is not nested
    // inside it, and the checkboxes still reach it by id.
    expect(markup).toContain('id="contact-directory-actions"');
    expect(markup).toContain('value="add-to-event"');
    expect(markup).toContain('form="contact-directory-actions"');
  });
});
