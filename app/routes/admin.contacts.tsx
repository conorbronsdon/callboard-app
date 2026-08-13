import { and, asc, desc, eq, inArray, isNotNull, isNull, ne, or, sql, type SQL } from "drizzle-orm";

import { buttonClass, inputClass } from "~/components/portal-ui";
import { LaneStub, linkClass, PageHeader } from "~/components/shell";
import { chunkedInsert, getDb } from "~/db/client.server";
import {
  commLog,
  contactNotes,
  contactSegments,
  contactTags,
  eventPeople,
  events,
  people,
  pipelineEntries,
  PIPELINE_STAGE_LABELS,
  sessionParticipants,
  stageTransitions,
  tasks,
  uploads,
  type PipelineStage,
} from "~/db/schema";
import { normalizeEmail, requireAdmin } from "~/lib/auth/auth.server";
import { MERGE_FALLBACKS } from "~/lib/comms/bulk";
import { sendOrgComm } from "~/lib/comms/org-bulk.server";
import { listEvents } from "~/lib/event.server";
import { getMailer } from "~/lib/mail/mailer.server";
import { enrollContact } from "~/lib/pipeline.server";
import { parseSpeakerCsv, type SpeakerImportPlan } from "~/lib/speakers/import-csv";
import type { Route } from "./+types/admin.contacts";

type BatchArgument = Parameters<ReturnType<typeof getDb>["batch"]>[0];

const BUTTON = buttonClass("primary");
const GHOST_BUTTON = buttonClass("secondary");

/* Kept in normal flow so the upload controls remain reachable on narrow screens. */
const DRAWER_PANEL =
  "mt-2 w-full space-y-3 rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-900";

function escapeLike(value: string): string {
  return value.replace(/!/g, "!!").replace(/%/g, "!%").replace(/_/g, "!_");
}

/** The only filter keys a saved segment may carry, in stored order. */
const SEGMENT_KEYS = ["q", "company", "title", "event", "notes", "tag"] as const;

/** Field labels for the "this filter no longer exists" notice. */
const FILTER_LABELS: Record<string, string> = {
  company: "Company",
  title: "Title",
  event: "Event",
  tag: "Tag",
};

/**
 * The stored form of a filtered view, rebuilt from an allowlist rather than
 * trusted as posted. The value comes back out into an `href` and is replayed by
 * whoever clicks the chip, so it never carries a key the directory does not
 * read.
 */
export function normalizeSegmentQuery(raw: string): string {
  const source = new URLSearchParams(raw.startsWith("?") ? raw.slice(1) : raw);
  const out = new URLSearchParams();
  for (const key of SEGMENT_KEYS) {
    const value = (source.get(key) ?? "").trim();
    if (value) out.set(key, value);
  }
  return out.toString();
}

/** A filter term dropped because the value it names no longer exists. */
export interface DroppedFilter {
  field: string;
  label: string;
  value: string;
}

export interface ContactsData {
  segments: { id: string; name: string; querystring: string }[];
  droppedFilters: DroppedFilter[];
  contacts: {
    id: string;
    fullName: string | null;
    email: string;
    company: string | null;
    title: string | null;
    eventsCount: number;
    notesCount: number;
    tags: string[];
    possibleDuplicate: boolean;
    pipelineStage: PipelineStage | null;
  }[];
  duplicateGroups: {
    name: string;
    contacts: { id: string; fullName: string | null; email: string; company: string | null; eventsCount: number }[];
  }[];
  stats: {
    totalContacts: number;
    totalEvents: number;
    returningContacts: number;
    topCompanies: { company: string; count: number }[];
  };
  companies: string[];
  titles: string[];
  tags: string[];
  events: { id: string; name: string }[];
  pipelineStages: Record<string, PipelineStage>;
  pipelineStageLabels: Record<PipelineStage, string>;
  q: string;
  company: string;
  title: string;
  event: string;
  notes: string;
  tag: string;
}

export function meta() {
  return [{ title: "Contacts — callboard admin" }];
}

export async function loader({ request }: Route.LoaderArgs): Promise<ContactsData> {
  await requireAdmin(request);
  const url = new URL(request.url);
  const q = (url.searchParams.get("q") ?? "").trim();
  /*
   * A fixed two-value vocabulary, so anything else is coerced away rather than
   * carried. The WHERE clause already ignored an unknown value; what it did NOT
   * do was stop the page believing it was filtered — which lit the "Save as
   * segment" control and would have stored `notes=garbage` as a segment that
   * silently returns the whole directory.
   */
  const notesParam = (url.searchParams.get("notes") ?? "").trim();
  const notes = notesParam === "with" || notesParam === "without" ? notesParam : "";
  const db = getDb();

  /*
   * WAVE 1 — the live vocabulary the four dropdown filters draw their options
   * from, plus the saved segments.
   *
   * This used to run in the same wave as the filtered query, which meant a
   * value that had since been deleted stayed in the WHERE clause while the
   * <select> beside it fell back to "Any": the controls claimed no filter was
   * applied and the table returned nothing. A saved segment makes that a
   * routine event rather than a curiosity — it is a link written months before
   * it is clicked — so the vocabulary is resolved FIRST and a term that names
   * something no longer there is dropped and reported.
   *
   * `q` is never dropped: free text does not have a vocabulary to fall out of.
   * `event=none` and `event=multi` are directory modes, not event ids.
   */
  const [companyRows, titleRows, tagRows, eventRows, segmentRows] = await Promise.all([
    db
      .selectDistinct({ value: people.company })
      .from(people)
      .where(and(isNull(people.mergedInto), isNotNull(people.company), ne(people.company, "")))
      .orderBy(asc(people.company)),
    db
      .selectDistinct({ value: people.title })
      .from(people)
      .where(and(isNull(people.mergedInto), isNotNull(people.title), ne(people.title, "")))
      .orderBy(asc(people.title)),
    // Joined to `people`: a tag whose only holder has been merged away is not
    // in the directory's vocabulary, and offering it in the picker produces an
    // option that can only ever return an empty table.
    db
      .select({ personId: contactTags.personId, tag: contactTags.tag })
      .from(contactTags)
      .innerJoin(people, eq(people.id, contactTags.personId))
      .where(isNull(people.mergedInto))
      .orderBy(asc(contactTags.tag)),
    listEvents(),
    db
      .select({ id: contactSegments.id, name: contactSegments.name, querystring: contactSegments.querystring })
      .from(contactSegments)
      .orderBy(asc(contactSegments.name)),
  ]);

  const companies = companyRows.flatMap((row) => (row.value ? [row.value] : []));
  const titles = titleRows.flatMap((row) => (row.value ? [row.value] : []));
  const tags = [...new Set(tagRows.map((row) => row.tag))];
  const eventIds = new Set(eventRows.map((row) => row.id));

  const droppedFilters: DroppedFilter[] = [];
  /** Keep the term only if the value it names still exists. */
  const live = (field: string, raw: string, exists: (value: string) => boolean): string => {
    const value = raw.trim();
    if (!value || exists(value)) return value;
    droppedFilters.push({ field, label: FILTER_LABELS[field] ?? field, value });
    return "";
  };

  const company = live("company", url.searchParams.get("company") ?? "", (value) =>
    companies.includes(value),
  );
  const title = live("title", url.searchParams.get("title") ?? "", (value) =>
    titles.includes(value),
  );
  const tag = live("tag", url.searchParams.get("tag") ?? "", (value) => tags.includes(value));

  /*
   * `listEvents()` is the SWITCHER's option list and it is capped at 20, so
   * "absent from `eventIds`" does not mean "deleted" — on an organisation with
   * more than twenty events it would mean "further down the list", and dropping
   * the term there would silently broaden a segment from one event to all of
   * them. Only a lookup can tell the two apart, and it runs solely when the
   * free in-memory check has already missed.
   */
  const eventParam = (url.searchParams.get("event") ?? "").trim();
  const eventIsLive =
    !eventParam ||
    eventParam === "none" ||
    eventParam === "multi" ||
    eventIds.has(eventParam) ||
    Boolean(
      await db.query.events.findFirst({
        where: eq(events.id, eventParam),
        columns: { id: true },
      }),
    );
  const event = live("event", eventParam, () => eventIsLive);

  const filters: SQL[] = [isNull(people.mergedInto)];

  if (q) {
    const pattern = `%${escapeLike(q.toLowerCase())}%`;
    filters.push(
      or(
        sql`lower(coalesce(${people.fullName}, '')) like ${pattern} escape '!'`,
        sql`lower(${people.email}) like ${pattern} escape '!'`,
        sql`lower(coalesce(${people.company}, '')) like ${pattern} escape '!'`,
        sql`lower(coalesce(${people.title}, '')) like ${pattern} escape '!'`,
      )!,
    );
  }
  if (company) filters.push(eq(people.company, company));
  if (title) filters.push(eq(people.title, title));
  if (event === "none") {
    filters.push(sql`not exists (select 1 from event_people where event_people.person_id = ${people.id})`);
  } else if (event === "multi") {
    filters.push(sql`(select count(*) from event_people where event_people.person_id = ${people.id}) >= 2`);
  } else if (event) {
    filters.push(sql`exists (select 1 from event_people where event_people.person_id = ${people.id} and event_people.event_id = ${event})`);
  }
  if (notes === "with") {
    filters.push(sql`exists (select 1 from contact_notes where contact_notes.person_id = ${people.id})`);
  } else if (notes === "without") {
    filters.push(sql`not exists (select 1 from contact_notes where contact_notes.person_id = ${people.id})`);
  }
  if (tag) {
    filters.push(sql`exists (select 1 from contact_tags where contact_tags.person_id = ${people.id} and contact_tags.tag = ${tag})`);
  }

  /* WAVE 2 — the filtered table and the rollups the stat cards print. */
  const [contactRows, duplicateRows, totalRows, allEventRows, returningRows, companyStats] = await Promise.all([
    db
      .select({
        id: people.id,
        fullName: people.fullName,
        email: people.email,
        company: people.company,
        title: people.title,
        eventsCount: sql<number>`(select count(*) from event_people where event_people.person_id = ${people.id})`,
        notesCount: sql<number>`(select count(*) from contact_notes where contact_notes.person_id = ${people.id})`,
      })
      .from(people)
      .where(and(...filters))
      .orderBy(asc(people.fullName), asc(people.email))
      .limit(200),
    db
      .select({
        id: people.id,
        fullName: people.fullName,
        email: people.email,
        company: people.company,
        eventsCount: sql<number>`(select count(*) from event_people where event_people.person_id = ${people.id})`,
      })
      .from(people)
      .where(isNull(people.mergedInto))
      .orderBy(asc(people.fullName), asc(people.email)),
    db.select({ count: sql<number>`count(*)` }).from(people).where(isNull(people.mergedInto)),
    db.select({ count: sql<number>`count(*)` }).from(events),
    db
      .select({ personId: eventPeople.personId })
      .from(eventPeople)
      .innerJoin(people, eq(people.id, eventPeople.personId))
      .where(isNull(people.mergedInto))
      .groupBy(eventPeople.personId)
      .having(sql`count(*) >= 2`),
    db
      .select({ company: people.company, count: sql<number>`count(*)` })
      .from(people)
      .where(and(isNull(people.mergedInto), isNotNull(people.company), ne(people.company, "")))
      .groupBy(people.company)
      .orderBy(desc(sql`count(*)`), asc(people.company))
      .limit(8),
  ]);

  const tagsByPerson = new Map<string, string[]>();
  for (const row of tagRows) {
    const values = tagsByPerson.get(row.personId) ?? [];
    values.push(row.tag);
    tagsByPerson.set(row.personId, values);
  }
  const duplicatesByName = new Map<string, typeof duplicateRows>();
  for (const row of duplicateRows) {
    const key = row.fullName?.trim().toLowerCase() ?? "";
    if (!key) continue;
    const values = duplicatesByName.get(key) ?? [];
    values.push(row);
    duplicatesByName.set(key, values);
  }
  const allDuplicateGroups = [...duplicatesByName.values()]
    .filter((rows) => rows.length >= 2 && new Set(rows.map((row) => row.email)).size >= 2)
    .map((rows) => ({ name: rows[0].fullName ?? rows[0].email, contacts: rows }));
  const duplicateGroups = allDuplicateGroups.slice(0, 10);
  const duplicateNames = new Set(allDuplicateGroups.map((group) => group.name.trim().toLowerCase()));
  const pipelineRows = contactRows.length
    ? await db
        .select({ personId: pipelineEntries.personId, stage: pipelineEntries.stage })
        .from(pipelineEntries)
        .where(inArray(pipelineEntries.personId, contactRows.map((row) => row.id)))
    : [];
  const pipelineStages = Object.fromEntries(
    pipelineRows.map((row) => [row.personId, row.stage]),
  ) as Record<string, PipelineStage>;
  const contacts = contactRows.map((row) => ({
    ...row,
    tags: tagsByPerson.get(row.id) ?? [],
    possibleDuplicate: Boolean(row.fullName && duplicateNames.has(row.fullName.trim().toLowerCase())),
    pipelineStage: pipelineStages[row.id] ?? null,
  }));

  return {
    segments: segmentRows,
    droppedFilters,
    contacts,
    duplicateGroups,
    stats: {
      totalContacts: totalRows[0]?.count ?? 0,
      totalEvents: allEventRows[0]?.count ?? 0,
      returningContacts: returningRows.length,
      topCompanies: companyStats.flatMap((row) => row.company ? [{ company: row.company, count: row.count }] : []),
    },
    companies,
    titles,
    tags,
    events: eventRows.map(({ id, name }) => ({ id, name })),
    pipelineStages,
    pipelineStageLabels: PIPELINE_STAGE_LABELS,
    q,
    company,
    title,
    event,
    notes,
    tag,
  };
}

export async function action({ request }: Route.ActionArgs) {
  const admin = await requireAdmin(request);
  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "");
  const db = getDb();

  if (intent === "enroll") {
    const personId = String(formData.get("personId") ?? "");
    const result = await enrollContact(db, {
      personId,
      score: formData.get("score"),
      rationale: formData.get("rationale"),
      movedByPersonId: admin.id,
    });
    if (!result.ok) return result;
    const person = await db.query.people.findFirst({ where: eq(people.id, personId) });
    const name = person?.fullName ?? person?.email ?? "Contact";
    return {
      ...result,
      intent,
      notice: `${name} added to the sourcing pipeline as Prospect.`,
    };
  }

  if (intent === "send-bulk") {
    const personIds = formData.getAll("personId").map(String);
    const contextEventId = String(formData.get("contextEventId") ?? "");
    if (!contextEventId) {
      return {
        ok: false as const,
        error: "Choose an event to supply the merge-field context.",
      };
    }
    const eventRow = await db.query.events.findFirst({
      where: eq(events.id, contextEventId),
    });
    if (!eventRow) {
      return {
        ok: false as const,
        error: "Choose an event to supply the merge-field context.",
      };
    }
    const result = await sendOrgComm({
      recipients: personIds,
      subject: String(formData.get("subject") ?? ""),
      body: String(formData.get("body") ?? ""),
      event: {
        name: eventRow.name,
        location: eventRow.location,
        timezone: eventRow.timezone,
      },
      eventId: eventRow.id,
      origin: new URL(request.url).origin,
      mailer: getMailer(),
      db,
    });
    if (result.error) return { ok: false as const, error: result.error };
    const notice = result.failed > 0
      ? `Sent ${result.sent} of ${result.attempted}; ${result.failed} failed.`
      : `Sent ${result.sent} of ${result.attempted}.`;
    return { ok: true as const, intent, notice };
  }

  if (intent === "save-segment") {
    const name = String(formData.get("name") ?? "").trim();
    const querystring = normalizeSegmentQuery(String(formData.get("querystring") ?? ""));
    if (!name) return { ok: false as const, error: "Name the segment before saving it." };
    if (name.length > 80) {
      return { ok: false as const, error: "A segment name is at most 80 characters." };
    }
    if (!querystring) {
      return {
        ok: false as const,
        error: "Filter the directory first - an unfiltered view is not a segment.",
      };
    }
    // Saving over an existing name updates it. The alternative is two chips
    // that read the same and filter differently.
    await db
      .insert(contactSegments)
      .values({ id: crypto.randomUUID(), name, querystring })
      .onConflictDoUpdate({ target: contactSegments.name, set: { querystring } });
    return { ok: true as const, intent, notice: `Saved the segment "${name}".` };
  }

  if (intent === "delete-segment") {
    const segmentId = String(formData.get("segmentId") ?? "");
    const removed = await db
      .delete(contactSegments)
      .where(eq(contactSegments.id, segmentId))
      .returning({ name: contactSegments.name });
    if (removed.length === 0) return { ok: false as const, error: "That segment no longer exists." };
    return { ok: true as const, intent, notice: `Deleted the segment "${removed[0].name}".` };
  }

  if (intent === "merge") {
    const primaryId = String(formData.get("primaryId") ?? "");
    const duplicateId = String(formData.get("duplicateId") ?? "");
    if (primaryId && primaryId === duplicateId) {
      return { ok: false as const, error: "A contact cannot be merged into itself." };
    }
    if (!primaryId || !duplicateId) {
      return { ok: false as const, error: "Choose both a surviving contact and a duplicate contact." };
    }
    const rows = await db.select().from(people).where(inArray(people.id, [primaryId, duplicateId]));
    const primary = rows.find((row) => row.id === primaryId);
    const duplicate = rows.find((row) => row.id === duplicateId);
    if (!primary || !duplicate) {
      return { ok: false as const, error: "Both contacts must exist before they can be merged." };
    }
    if (primary.mergedInto || duplicate.mergedInto) {
      return { ok: false as const, error: "A contact that was already merged cannot be merged again." };
    }

    const [membershipRows, noteRows] = await Promise.all([
      db.select({ count: sql<number>`count(*)` }).from(eventPeople).where(eq(eventPeople.personId, duplicateId)),
      db.select({ count: sql<number>`count(*)` }).from(contactNotes).where(eq(contactNotes.personId, duplicateId)),
    ]);
    const chooseText = (winner: string | null, loser: string | null) => winner?.trim() ? winner : loser;
    const winnerLinks = primary.links && Object.keys(primary.links).length > 0 ? primary.links : duplicate.links;
    /*
     * CONSENT MUST TRAVEL WITH THE KEY.
     *
     * `chooseText` keeps the primary's headshot only when it actually has one;
     * otherwise the survivor adopts the DUPLICATE's key. `photo_publishable` is
     * consent granted for a SPECIFIC uploaded file (DECISIONS #66), so it has to
     * follow whichever key wins. Copying the key while leaving the flag on the
     * primary's standing value would let the primary's consent launder the
     * duplicate's unconsented photo onto the public directory — the merge
     * installs the duplicate's key under the primary's true flag and the
     * anonymous photo route then serves bytes nobody agreed to publish. The
     * mirror failure is just as wrong: keeping the primary's `false` over the
     * duplicate's real consent would silently un-publish a photo its subject DID
     * agree to. Bind the flag to the key that survives, never to the record.
     */
    const primaryKeepsOwnHeadshot = Boolean(primary.headshotKey?.trim());
    const mergedHeadshotKey = primaryKeepsOwnHeadshot ? primary.headshotKey : duplicate.headshotKey;
    const mergedPhotoPublishable = primaryKeepsOwnHeadshot
      ? primary.photoPublishable
      : duplicate.photoPublishable;
    const statements = [
      db.delete(eventPeople).where(and(
        eq(eventPeople.personId, duplicateId),
        sql`exists (select 1 from event_people as winner where winner.event_id = ${eventPeople.eventId} and winner.person_id = ${primaryId})`,
      )),
      db.update(eventPeople).set({ personId: primaryId }).where(eq(eventPeople.personId, duplicateId)),
      db.delete(contactTags).where(and(
        eq(contactTags.personId, duplicateId),
        sql`exists (select 1 from contact_tags as winner where winner.tag = ${contactTags.tag} and winner.person_id = ${primaryId})`,
      )),
      db.update(contactTags).set({ personId: primaryId }).where(eq(contactTags.personId, duplicateId)),
      db.delete(sessionParticipants).where(and(
        eq(sessionParticipants.personId, duplicateId),
        sql`exists (select 1 from session_participants as winner where winner.session_id = ${sessionParticipants.sessionId} and winner.role = ${sessionParticipants.role} and winner.person_id = ${primaryId})`,
      )),
      db.update(sessionParticipants).set({ personId: primaryId }).where(eq(sessionParticipants.personId, duplicateId)),
      db.update(tasks).set({ personId: primaryId }).where(eq(tasks.personId, duplicateId)),
      db.update(commLog).set({ personId: primaryId }).where(eq(commLog.personId, duplicateId)),
      db.update(contactNotes).set({ personId: primaryId }).where(eq(contactNotes.personId, duplicateId)),
      db.update(uploads).set({ uploadedById: primaryId }).where(eq(uploads.uploadedById, duplicateId)),
      db.update(uploads).set({ ownerId: primaryId }).where(and(eq(uploads.ownerType, "person"), eq(uploads.ownerId, duplicateId))),
      db.delete(pipelineEntries).where(and(
        eq(pipelineEntries.personId, duplicateId),
        sql`exists (select 1 from pipeline_entries as winner where winner.person_id = ${primaryId})`,
      )),
      db.update(pipelineEntries).set({ personId: primaryId }).where(eq(pipelineEntries.personId, duplicateId)),
      db.update(stageTransitions).set({ personId: primaryId }).where(eq(stageTransitions.personId, duplicateId)),
      db.update(people).set({
        fullName: chooseText(primary.fullName, duplicate.fullName),
        company: chooseText(primary.company, duplicate.company),
        title: chooseText(primary.title, duplicate.title),
        bio: chooseText(primary.bio, duplicate.bio),
        pronouns: chooseText(primary.pronouns, duplicate.pronouns),
        headshotKey: mergedHeadshotKey,
        photoPublishable: mergedPhotoPublishable,
        links: winnerLinks,
        travelNotes: chooseText(primary.travelNotes, duplicate.travelNotes),
      }).where(eq(people.id, primaryId)),
      /*
       * DECISIONS #66 binds consent to the key. A tombstone no longer owns the
       * key, so retaining either half leaves a stale pointer and a true flag
       * with no artifact under it.
       */
      db.update(people).set({
        mergedInto: primaryId,
        headshotKey: null,
        photoPublishable: false,
      }).where(eq(people.id, duplicateId)),
    ];
    await db.batch(statements as unknown as BatchArgument);
    const memberships = membershipRows[0]?.count ?? 0;
    const notesMoved = noteRows[0]?.count ?? 0;
    return {
      ok: true as const,
      intent,
      notice: `Merged ${duplicate.email} into ${primary.email} - ${memberships} event membership${memberships === 1 ? "" : "s"} and ${notesMoved} note${notesMoved === 1 ? "" : "s"} moved.`,
    };
  }

  if (intent === "import-preview" || intent === "import-commit") {
    let rawCsv: string;
    if (intent === "import-preview") {
      const upload = formData.get("file");
      if (!upload || typeof upload === "string" || typeof upload.text !== "function") {
        return { ok: false as const, error: "Choose a CSV file to preview." };
      }
      rawCsv = await upload.text();
    } else {
      rawCsv = String(formData.get("rawCsv") ?? "");
    }

    const emailRows = await db.select({ email: people.email }).from(people);
    const globalEmails = new Set(emailRows.map((row) => normalizeEmail(row.email)));
    const plan = parseSpeakerCsv(rawCsv, globalEmails);
    if (plan.fatalError) {
      return { ok: false as const, error: plan.fatalError, preview: plan, rawCsv };
    }
    if (intent === "import-preview") {
      return { ok: true as const, intent, preview: plan, rawCsv };
    }
    if (plan.counts.error > 0) {
      return {
        ok: false as const,
        error: "Import refused because one or more rows have errors. No contacts were added.",
        preview: plan,
        rawCsv,
      };
    }

    const creates = plan.rows.filter((row) => row.classification === "create");
    const rows = creates.map((row) => ({
      id: crypto.randomUUID(),
      email: row.email,
      fullName: row.fullName,
      title: row.title || null,
      company: row.company || null,
      bio: row.bio || null,
      role: "speaker" as const,
    }));
    const statements = chunkedInsert(rows, (chunk) => db.insert(people).values(chunk));
    if (statements.length > 0) await db.batch(statements as unknown as BatchArgument);

    return {
      ok: true as const,
      intent,
      preview: plan,
      notice: `Imported ${creates.length} contact${creates.length === 1 ? "" : "s"}; ${plan.counts.duplicate} duplicate${plan.counts.duplicate === 1 ? "" : "s"} skipped.`,
    };
  }

  if (intent === "add-to-event") {
    const personIds = [...new Set(formData.getAll("personId").map(String).filter(Boolean))];
    const eventId = String(formData.get("eventId") ?? "");
    if (personIds.length === 0) {
      return { ok: false as const, error: "Select at least one contact." };
    }
    const eventRow = await db.query.events.findFirst({ where: eq(events.id, eventId) });
    if (!eventRow) return { ok: false as const, error: "Choose a real event." };

    const validRows = await db
      .select({ id: people.id })
      .from(people)
      .where(and(inArray(people.id, personIds), isNull(people.mergedInto)));
    const validIds = validRows.map((row) => row.id);
    if (validIds.length === 0) {
      return { ok: false as const, error: "None of the selected contacts exists." };
    }
    const existing = await db
      .select({ personId: eventPeople.personId })
      .from(eventPeople)
      .where(and(eq(eventPeople.eventId, eventId), inArray(eventPeople.personId, validIds)));
    const existingIds = new Set(existing.map((row) => row.personId));
    const added = validIds.filter((id) => !existingIds.has(id)).length;
    const inserts = chunkedInsert(
      validIds.map((personId) => ({ eventId, personId, eventRole: "speaker" })),
      (chunk) => db.insert(eventPeople).values(chunk).onConflictDoNothing(),
    );
    if (inserts.length > 0) await db.batch(inserts as unknown as BatchArgument);

    return {
      ok: true as const,
      intent,
      notice: `Added ${added} contact${added === 1 ? "" : "s"} to ${eventRow.name} using their existing profiles; no duplicate contacts were created.`,
    };
  }

  return { ok: false as const, error: `Unknown intent "${intent}".` };
}

function ImportDrawer() {
  return (
    <details data-testid="import-contact-drawer">
      <summary className={`${GHOST_BUTTON} cursor-pointer list-none`}>Import CSV</summary>
      <form method="post" encType="multipart/form-data" className={DRAWER_PANEL}>
        <input type="hidden" name="intent" value="import-preview" />
        <p className="text-sm font-semibold">Import contacts</p>
        <p className="text-xs text-gray-500 dark:text-gray-400">
          Preview every row first. Imported contacts are not attached to any event.
        </p>
        <label className="block text-sm">
          CSV file
          <input name="file" type="file" accept=".csv,text/csv" required className={inputClass} />
        </label>
        <button type="submit" className={BUTTON}>Preview import</button>
      </form>
    </details>
  );
}

function ImportPreview({ plan, rawCsv }: { plan: SpeakerImportPlan; rawCsv?: string }) {
  return (
    <section className="space-y-3 rounded-lg border border-gray-200 p-4 dark:border-gray-800" data-testid="contact-import-preview">
      <div>
        <h3 className="font-semibold">Import preview</h3>
        <p className="text-sm text-gray-500 dark:text-gray-400">
          {plan.counts.create} to create - {plan.counts.duplicate} duplicates skipped - {plan.counts.error} errors
        </p>
      </div>
      {plan.rows.length ? (
        <div className="overflow-x-auto">
          <table className="min-w-full text-left text-sm">
            <thead><tr className="border-b dark:border-gray-700"><th className="p-2">Row</th><th className="p-2">Name</th><th className="p-2">Email</th><th className="p-2">Result</th><th className="p-2">Reason</th></tr></thead>
            <tbody>{plan.rows.map((row) => (
              <tr key={row.rowNumber} className="border-b border-gray-100 dark:border-gray-800">
                <td className="p-2">{row.rowNumber}</td><td className="p-2">{row.fullName || "-"}</td><td className="p-2">{row.email || "-"}</td><td className="p-2">{row.classification}</td><td className="p-2 text-gray-500 dark:text-gray-400">{row.reason ?? "-"}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      ) : null}
      {rawCsv ? (
        <form method="post">
          <input type="hidden" name="intent" value="import-commit" />
          <input type="hidden" name="rawCsv" value={rawCsv} />
          <button type="submit" className={BUTTON}>Commit import</button>
        </form>
      ) : null}
    </section>
  );
}

type ContactsActionData = Awaited<ReturnType<typeof action>> | undefined;

/** `/admin/contacts?…` for a saved segment. An empty query is the bare directory. */
export function segmentHref(querystring: string): string {
  return querystring ? `/admin/contacts?${querystring}` : "/admin/contacts";
}

function SavedSegments({ data, currentQuery }: { data: ContactsData; currentQuery: string }) {
  return (
    <section
      data-testid="contact-segments"
      className="space-y-3 rounded-lg border border-gray-200 p-4 dark:border-gray-800 dark:bg-gray-950"
    >
      <div>
        <h3 className="font-semibold">Saved segments</h3>
        <p className="text-xs text-gray-500 dark:text-gray-400">
          A named, reusable filter. Opening one re-applies exactly the filters it was saved with.
        </p>
      </div>
      {data.segments.length ? (
        <ul className="flex flex-wrap gap-2">
          {data.segments.map((segment) => (
            <li
              key={segment.id}
              data-testid="contact-segment"
              className="flex items-center gap-2 rounded-full border border-gray-200 px-3 py-1 dark:border-gray-700"
            >
              <a className={`${linkClass} text-sm`} href={segmentHref(segment.querystring)}>
                {segment.name}
              </a>
              <form method="post">
                <input type="hidden" name="intent" value="delete-segment" />
                <input type="hidden" name="segmentId" value={segment.id} />
                <button
                  type="submit"
                  aria-label={`Delete segment ${segment.name}`}
                  className="text-sm text-gray-500 hover:text-rose-700 dark:text-gray-400 dark:hover:text-rose-300"
                >
                  &times;
                </button>
              </form>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-gray-500 dark:text-gray-400">
          None yet. Filter the directory below, then save that view as a segment.
        </p>
      )}
      <form method="post" className="flex flex-wrap items-end gap-2">
        <input type="hidden" name="intent" value="save-segment" />
        <input type="hidden" name="querystring" value={currentQuery} />
        <label className="text-sm">
          Segment name
          <input name="name" maxLength={80} required className={inputClass} placeholder="e.g. Returning workshop leads" />
        </label>
        <button type="submit" className={GHOST_BUTTON} disabled={!currentQuery}>
          Save as segment
        </button>
        {currentQuery ? null : (
          <p className="basis-full text-xs text-gray-500 dark:text-gray-400">
            Apply a filter to enable this.
          </p>
        )}
      </form>
    </section>
  );
}

export function ContactsScreen({ data, actionData }: { data: ContactsData; actionData?: ContactsActionData }) {
  const preview = actionData && "preview" in actionData ? actionData.preview : null;
  const rawCsv = actionData && "rawCsv" in actionData ? actionData.rawCsv : undefined;
  const anyFilter = Boolean(data.q || data.company || data.title || data.event || data.notes || data.tag);
  const largestCompany = Math.max(0, ...data.stats.topCompanies.map((row) => row.count));
  /*
   * Built from the filters the loader ACTUALLY applied, not from the URL: a
   * segment saved while looking at a stale view must not inherit the dead term
   * the loader just dropped.
   */
  const currentQuery = normalizeSegmentQuery(
    new URLSearchParams({
      q: data.q,
      company: data.company,
      title: data.title,
      event: data.event,
      notes: data.notes,
      tag: data.tag,
    }).toString(),
  );

  return (
    <div className="space-y-4">
      <PageHeader
        title="Contacts"
        description="One organization-level directory spanning every event. Everyone who has ever submitted, spoken or been imported lives here once."
      />
      {/*
       * `items-start`, and it is the whole fix for this row: a stretched grid
       * gave the three count tiles the height of the ranked list beside them,
       * so each printed a two-digit number over ~250px of empty white. Tiles
       * size to their own content now; only the list is as tall as its data.
       */}
      <section data-testid="contact-stats" className="grid items-start gap-3 lg:grid-cols-4">
        {[
          ["Total contacts", data.stats.totalContacts],
          ["Events", data.stats.totalEvents],
          ["Returning contacts", data.stats.returningContacts],
        ].map(([label, value]) => <div key={label} className="rounded-lg border border-gray-200 bg-white p-4 shadow-card dark:border-gray-800 dark:bg-gray-900"><p className="text-sm text-gray-600 dark:text-gray-400">{label}</p><p className="mt-1 text-3xl font-semibold tabular-nums">{value}</p></div>)}
        <div className="rounded-lg border border-gray-200 bg-white p-4 shadow-card dark:border-gray-800 dark:bg-gray-900">
          <h3 className="font-semibold">Top companies</h3>
          {data.stats.topCompanies.length ? (<>
            {/*
             * The bars are suppressed when every company ties, which on the
             * seeded event is ALWAYS: eight companies with one contact each
             * were drawn as eight identical full-width blue bars — a chart
             * whose every value is its own maximum reads as a loading state,
             * not as data. A tie gets a sentence instead.
             */}
            <ul className="mt-3 space-y-2">{data.stats.topCompanies.map((row) => <li key={row.company} className="text-xs"><div className="flex justify-between gap-2"><a className={linkClass} href={`/admin/contacts?company=${encodeURIComponent(row.company)}`}>{row.company}</a><span className="tabular-nums text-gray-600 dark:text-gray-400">{row.count}</span></div>{largestCompany > 1 ? <div className="mt-1 h-1.5 rounded-full bg-gray-100 dark:bg-gray-800"><div className="h-1.5 rounded-full bg-blue-500 dark:bg-blue-400" style={{ width: `${(row.count / largestCompany) * 100}%` }} /></div> : null}</li>)}</ul>
            {largestCompany <= 1 ? <p className="mt-3 text-xs text-gray-500 dark:text-gray-400">One contact each — no company leads yet.</p> : null}
          </>) : <p className="mt-2 text-sm text-gray-500 dark:text-gray-400">No company data yet. Company names arrive with a CSV import or the first submission.</p>}
        </div>
      </section>
      <ImportDrawer />
      {actionData && "error" in actionData ? <p role="alert" className="rounded-lg bg-rose-50 p-3 text-sm text-rose-800 dark:bg-rose-950 dark:text-rose-200">{actionData.error}</p> : null}
      {actionData && "notice" in actionData ? <p role="status" className="rounded-lg bg-green-50 p-3 text-sm text-green-800 dark:bg-green-950 dark:text-green-200">{actionData.notice}</p> : null}
      {preview ? <ImportPreview plan={preview} rawCsv={rawCsv} /> : null}

      {data.duplicateGroups.length ? <section data-testid="contact-duplicates" className="space-y-3 rounded-lg border border-amber-300 bg-amber-50 p-4 dark:border-amber-800 dark:bg-amber-950">
        <div><h3 className="font-semibold">Possible duplicates</h3><p className="text-sm text-amber-900 dark:text-amber-100">Review carefully. Merging cannot be undone.</p></div>
        {data.duplicateGroups.map((group) => <form key={group.name} method="post" className="grid gap-2 rounded-lg border border-amber-200 p-3 sm:grid-cols-3 dark:border-amber-800">
          <input type="hidden" name="intent" value="merge" />
          <label className="text-sm">Keep<select name="primaryId" required className={inputClass}>{group.contacts.map((contact) => <option key={contact.id} value={contact.id}>{contact.fullName ?? contact.email} - {contact.email}</option>)}</select></label>
          <label className="text-sm">Merge away<select name="duplicateId" required className={inputClass}>{group.contacts.map((contact) => <option key={contact.id} value={contact.id}>{contact.fullName ?? contact.email} - {contact.email}</option>)}</select></label>
          <div className="flex items-end"><button type="submit" className={BUTTON}>Merge contacts</button></div>
        </form>)}
      </section> : null}

      <SavedSegments data={data} currentQuery={currentQuery} />

      {data.droppedFilters.length ? (
        <p
          role="status"
          data-testid="contact-dropped-filters"
          className="rounded-lg bg-amber-50 p-3 text-sm text-amber-900 dark:bg-amber-950 dark:text-amber-100"
        >
          Showing the rest of this view.{" "}
          {data.droppedFilters
            .map((dropped) => `${dropped.label} "${dropped.value}" no longer exists`)
            .join("; ")}
          .
        </p>
      ) : null}

      <form method="get" role="search" data-testid="contact-filters" className="grid gap-3 rounded-lg border border-gray-200 p-4 sm:grid-cols-2 lg:grid-cols-6 dark:border-gray-800 dark:bg-gray-950">
        <label className="text-sm">Search<input name="q" defaultValue={data.q} className={inputClass} placeholder="Name, email, company, title" /></label>
        <label className="text-sm">Company<select name="company" defaultValue={data.company} className={inputClass}><option value="">Any company</option>{data.companies.map((value) => <option key={value} value={value}>{value}</option>)}</select></label>
        <label className="text-sm">Title<select name="title" defaultValue={data.title} className={inputClass}><option value="">Any title</option>{data.titles.map((value) => <option key={value} value={value}>{value}</option>)}</select></label>
        <label className="text-sm">Event<select name="event" defaultValue={data.event} className={inputClass}><option value="">Any</option><option value="none">Not on any event</option><option value="multi">On 2+ events</option>{data.events.map((row) => <option key={row.id} value={row.id}>{row.name}</option>)}</select></label>
        <label className="text-sm">Notes<select name="notes" defaultValue={data.notes} className={inputClass}><option value="">Any</option><option value="with">Has notes</option><option value="without">No notes</option></select></label>
        <label className="text-sm">Tag<select name="tag" defaultValue={data.tag} className={inputClass}><option value="">Any tag</option>{data.tags.map((value) => <option key={value} value={value}>{value}</option>)}</select></label>
        <div className="flex items-center gap-2 lg:col-span-6"><button type="submit" className={BUTTON}>Filter</button>{anyFilter ? <a href="/admin/contacts" className={linkClass}>Clear</a> : null}</div>
      </form>

      {data.contacts.length === 0 ? (
        <LaneStub lane="No contacts found">{anyFilter ? "No contacts match these filters." : "Import or add a contact to begin."}</LaneStub>
      ) : (
        <div data-testid="contact-directory" className="space-y-3">
          <div className="overflow-x-auto rounded-lg border border-gray-200 dark:border-gray-800">
            <table className="min-w-full text-left text-sm">
              <thead className="bg-gray-50 dark:bg-gray-900"><tr><th className="p-3"><span className="sr-only">Select</span></th><th className="p-3">Name</th><th className="p-3">Email</th><th className="p-3">Company</th><th className="p-3">Title</th><th className="p-3">Events</th><th className="p-3">Notes</th><th className="p-3">Pipeline</th></tr></thead>
              <tbody>{data.contacts.map((contact) => (
                <tr key={contact.id} className="border-t border-gray-200 dark:border-gray-800">
                  <td className="p-3"><input type="checkbox" name="personId" value={contact.id} form="contact-directory-actions" aria-label={`Select ${contact.fullName ?? contact.email}`} /></td>
                  <td className="p-3 font-medium"><div className="flex flex-wrap items-center gap-1"><a className={linkClass} href={`/admin/contacts/${contact.id}`}>{contact.fullName ?? contact.email}</a>{contact.possibleDuplicate ? <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs text-amber-900 dark:bg-amber-900 dark:text-amber-100">Possible duplicate</span> : null}</div>{contact.tags.length ? <div className="mt-1 flex flex-wrap gap-1">{contact.tags.map((tag) => <span key={tag} className="rounded-full bg-gray-100 px-2 py-0.5 text-xs font-normal dark:bg-gray-800">{tag}</span>)}</div> : null}</td>
                  <td className="p-3">{contact.email}</td><td className="p-3">{contact.company ?? "-"}</td><td className="p-3">{contact.title ?? "-"}</td><td className="p-3">{contact.eventsCount}</td><td className="p-3">{contact.notesCount}</td>
                  <td className="p-3">{contact.pipelineStage ? (
                    <span className="rounded-full bg-blue-100 px-2 py-0.5 text-xs font-medium text-blue-800 dark:bg-blue-950 dark:text-blue-200">{data.pipelineStageLabels[contact.pipelineStage]}</span>
                  ) : (
                    <form method="post" className="flex min-w-96 items-end gap-2">
                      <input type="hidden" name="personId" value={contact.id} />
                      <span className="w-20">
                        <label className="sr-only" htmlFor={`pipeline-score-${contact.id}`}>Score for {contact.fullName ?? contact.email}</label>
                        <input id={`pipeline-score-${contact.id}`} name="score" type="number" min={0} max={100} placeholder="Score" className={inputClass} />
                      </span>
                      <span className="min-w-44 flex-1">
                        <label className="sr-only" htmlFor={`pipeline-rationale-${contact.id}`}>Rationale for {contact.fullName ?? contact.email}</label>
                        <input id={`pipeline-rationale-${contact.id}`} name="rationale" type="text" maxLength={1000} placeholder="Rationale" className={inputClass} />
                      </span>
                      <button type="submit" name="intent" value="enroll" className={buttonClass("secondary", "sm")}>Enroll</button>
                    </form>
                  )}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
          <form method="post" id="contact-directory-actions" className="space-y-3">
          <div className="flex flex-wrap items-end gap-3 rounded-lg border border-gray-200 p-3 dark:border-gray-800 dark:bg-gray-950">
            {/* NOT `required`. The directory is one form with two submit
                buttons -- Add to event and Send email -- and a required control
                is validated for BOTH, so `required` here made "Send email"
                unclickable in a browser while every server-side test still
                passed. The action already refuses an empty or unknown event. */}
            <label className="text-sm">Add to event<select name="eventId" className={inputClass}><option value="">Choose an event</option>{data.events.map((row) => <option key={row.id} value={row.id}>{row.name}</option>)}</select></label>
            <button type="submit" name="intent" value="add-to-event" className={BUTTON}>Add to event</button>
            <p className="basis-full text-xs text-gray-500 dark:text-gray-400">Adding a contact reuses their existing profile rather than creating a new record.</p>
          </div>
          <section data-testid="contact-compose" className="space-y-3 rounded-lg border border-gray-200 p-3 dark:border-gray-800 dark:bg-gray-950">
            <h3 className="font-semibold">Email selected contacts</h3>
            <label className="block text-sm">
              Merge-field context
              <select name="contextEventId" className={inputClass} defaultValue="">
                <option value="">Choose an event</option>
                {data.events.map((row) => <option key={row.id} value={row.id}>{row.name}</option>)}
              </select>
            </label>
            <p className="text-xs text-gray-500 dark:text-gray-400">
              The chosen event's name and timezone fill the {"{{event.*}}"} tokens.
            </p>
            <label className="block text-sm">
              Subject
              <input name="subject" className={inputClass} />
            </label>
            <label className="block text-sm">
              Body
              <textarea name="body" rows={7} className={inputClass} />
            </label>
            <p className="text-xs text-gray-500 dark:text-gray-400">
              Merge fields available without a session: {Object.keys(MERGE_FALLBACKS).map((key) => `{{${key}}}`).join(", ")}
            </p>
            <button type="submit" name="intent" value="send-bulk" className={BUTTON}>Send email</button>
          </section>
          </form>
        </div>
      )}
      <p data-testid="contact-row-count" className="text-sm text-gray-500 dark:text-gray-400">{data.contacts.length} contacts shown.</p>
    </div>
  );
}

export default function AdminContacts({ loaderData, actionData }: Route.ComponentProps) {
  return <ContactsScreen data={loaderData} actionData={actionData} />;
}
