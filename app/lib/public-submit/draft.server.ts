/**
 * Server side of the public submission wizard: context loading, draft
 * persistence, uploads, and the final submit.
 *
 * D1 has NO interactive transactions — every multi-statement write here goes
 * through `db.batch([...])` (AGENTS.md / app/db/client.server.ts).
 */
import { and, desc, eq, inArray, isNull, ne } from "drizzle-orm";

import { getDb, type DB } from "~/db/client.server";
import {
  eventPeople,
  events,
  fields as fieldsTable,
  formats,
  forms,
  levels,
  people,
  sessionParticipants,
  sessionRevisions,
  sessions,
  tracks,
  uploads,
  type Event as EventRow,
  type Form as FormRow,
  type Person,
} from "~/db/schema";
import { getCurrentPerson, normalizeEmail } from "~/lib/auth/auth.server";
import { withCommLog } from "~/lib/comms/comm-log.server";
import { loadTemplate } from "~/lib/comms/templates.server";
import { appUrl } from "~/lib/env.server";
import { getMailer } from "~/lib/mail/mailer.server";
import { storeUpload } from "~/lib/portal/uploads.server";
import { PUBLIC_SUBMIT_FILE_PURPOSE } from "~/lib/portal-uploads";

import { sendSubmissionConfirmation } from "./confirmation";
import {
  checkEligibleTrack,
  hydrateFieldRefs,
  resolveSubmittedTrack,
  routeCategory,
  textOf,
  toFormDefinition,
  visibleFields,
  type AnswerValue,
  type FormDefinition,
} from "./contract";
import { resolveFormatAndLevel } from "./normalize";
import {
  CONTENT_KEY,
  EMPTY_CONTENT,
  TRACK_KEY,
  checkSubmissionLimit,
  closedReason,
  toFormAnswers,
  type ClosedReason,
  type DraftContent,
  type DraftParticipant,
  type LimitCheck,
} from "./wizard";

export { CONTENT_KEY, EMPTY_CONTENT };
export type { DraftContent };

/**
 * `db.batch` takes a non-empty tuple; we build a plain array and cast once at
 * the call site rather than threading tuple types through the builder.
 */
type BatchArgument = Parameters<DB["batch"]>[0];
type BatchStatement = BatchArgument[number];

/** Keys whose answer becomes `sessions.description` and the abstract check. */
const ABSTRACT_KEYS = ["abstract", "description", "body"];

export interface DraftView {
  id: string;
  status: string;
  title: string;
  /** Submission-scope answers, keyed by field key. */
  fields: Record<string, AnswerValue>;
  participants: DraftParticipant[];
  content: DraftContent;
  /**
   * The submitter's eligible-track choice, when the form offers one.
   *
   * Optional rather than required: a draft written before this existed carries
   * no choice, and a form with the control off never asks for one.
   */
  trackId?: string | null;
}

export interface SubmitContext {
  event: EventRow;
  form: FormRow;
  /** WS1a's flat evaluator input, enriched from the per-event field registry. */
  def: FormDefinition;
  person: Person | null;
  draft: DraftView | null;
  limit: LimitCheck;
  closed: ClosedReason;
  /**
   * The tracks this form accepts, in event order. Empty when the organizer has
   * not turned the eligible-tracks control on, which is also the signal to the
   * wizard that there is no picker to render.
   */
  eligibleTracks: { id: string; name: string }[];
}

/* ---------------------------------------------------------------- loading */

function toDraftView(row: typeof sessions.$inferSelect): DraftView {
  const blob = (row.answers ?? {}) as Record<string, unknown>;
  const fields = (blob.fields ?? {}) as Record<string, AnswerValue>;
  const participants = Array.isArray(blob.participants)
    ? (blob.participants as DraftParticipant[]).filter(
        (entry) => typeof entry === "object" && entry !== null && "email" in entry,
      )
    : [];
  const content =
    typeof blob[CONTENT_KEY] === "object" && blob[CONTENT_KEY] !== null
      ? { ...EMPTY_CONTENT, ...(blob[CONTENT_KEY] as Partial<DraftContent>) }
      : { ...EMPTY_CONTENT };

  const trackId = typeof blob[TRACK_KEY] === "string" ? (blob[TRACK_KEY] as string) : null;

  return {
    id: row.id,
    status: row.status,
    title: row.title,
    fields,
    participants,
    content,
    trackId,
  };
}

/** The JSON blob a draft row stores. */
function draftBlob(input: {
  fields: Record<string, AnswerValue>;
  participants: DraftParticipant[];
  content: DraftContent;
  trackId?: string | null;
}) {
  return {
    fields: input.fields,
    participants: input.participants,
    [CONTENT_KEY]: input.content,
    [TRACK_KEY]: input.trackId ?? null,
  };
}

/**
 * Everything the wizard needs in one round of queries. Throws 404 responses for
 * an unknown event or form — the public route must not leak which ids exist.
 */
export async function loadSubmitContext(input: {
  request: Request;
  eventSlug: string;
  formId: string;
}): Promise<SubmitContext> {
  const db = getDb();

  const event = await db.query.events.findFirst({
    where: eq(events.slug, input.eventSlug),
  });
  if (!event) throw new Response("Event not found", { status: 404 });

  const form = await db.query.forms.findFirst({
    where: and(
      eq(forms.id, input.formId),
      eq(forms.eventId, event.id),
      eq(forms.surface, "cfp"),
    ),
  });
  if (!form) throw new Response("Form not found", { status: 404 });

  const registry = await db.query.fields.findMany({
    where: and(eq(fieldsTable.eventId, event.id), isNull(fieldsTable.archivedAt)),
  });

  const parsed = toFormDefinition(form);
  const def: FormDefinition = {
    ...parsed,
    fields: hydrateFieldRefs(parsed.fields, registry),
    participants: participantsFromColumns(parsed, form),
  };

  // Only queried when the control is on: a form that never turned it on must
  // not pay for a tracks read on the speed-scored public path.
  const eligibleTracks = def.eligibleTrackIds.length
    ? await eligibleTracksFor(event.id, def.eligibleTrackIds)
    : [];

  const person = await getCurrentPerson(input.request);

  let draft: DraftView | null = null;
  let used = 0;
  if (person) {
    const owned = await ownedSubmissions(event, form, person.id);
    used = owned.length;
    const draftRow = owned.find((row) => row.status === "draft");
    draft = draftRow ? toDraftView(draftRow) : null;
  }

  return {
    event,
    form,
    def,
    person,
    draft,
    limit: checkSubmissionLimit({
      formLimit: form.submissionLimit,
      eventLimit: event.submissionLimit,
      used,
    }),
    closed: closedReason(def) ?? unsubmittableReason(def.eligibleTrackIds, eligibleTracks),
    eligibleTracks,
  };
}

/**
 * The form is open, and there is still no way to submit to it.
 *
 * `checkEligibleTrack` demands a choice whenever the CONFIGURED id list is
 * non-empty, while the picker renders from the RESOLVED list. Delete every
 * track a form lists as eligible and the two disagree: the select disappears,
 * the server keeps requiring a track, and the `__track` error is rendered
 * inside the block that is no longer there — the summary filters `__` keys out
 * (public.submit.step.tsx:702). The submitter got a 400 and a page that said
 * nothing.
 *
 * Rather than paper over it by letting the submission through — which would
 * put rows in tracks the organizer removed — the form says so, through the
 * same closed presentation a past close date uses. It is a real state: nobody
 * can submit, and no submitter can fix it.
 *
 * Deliberately NOT the same thing as the control being off. An empty
 * `eligibleTrackIds` means the organizer never asked the question, and
 * `checkEligibleTrack` returns `{ ok: true, trackId: null }` for it — those
 * forms are open and must stay open.
 */
function unsubmittableReason(
  configuredIds: readonly string[],
  resolved: readonly { id: string }[],
): ClosedReason {
  return configuredIds.length > 0 && resolved.length === 0 ? "no_eligible_tracks" : null;
}

/**
 * Resolve the configured ids to real tracks ON THIS EVENT.
 *
 * The event filter is the point. Ids live in a JSON blob that survives a track
 * being deleted and could in principle name a track from another event; joining
 * against the event's own tracks means a stale or foreign id renders as nothing
 * and validates as nothing, rather than putting a stranger's track on a public
 * form. Ordered by the event's track order so the picker matches every other
 * track list in the product.
 */
async function eligibleTracksFor(
  eventId: string,
  ids: readonly string[],
): Promise<{ id: string; name: string }[]> {
  const allowed = new Set(ids);
  const rows = await getDb()
    .select({ id: tracks.id, name: tracks.name, order: tracks.order })
    .from(tracks)
    .where(eq(tracks.eventId, eventId));

  return rows
    .filter((row) => allowed.has(row.id))
    .sort((a, b) => a.order - b.order || a.name.localeCompare(b.name))
    .map((row) => ({ id: row.id, name: row.name }));
}

/**
 * Role bounds live in two places: real `forms` columns (WS0's schema, which the
 * seed and the admin list query) and WS1a's richer `schema.participants` JSON.
 * The columns win when the JSON is still at its defaults, so a form built before
 * the rule editor existed still enforces its min/max on the public page.
 */
function participantsFromColumns(
  def: FormDefinition,
  form: FormRow,
): FormDefinition["participants"] {
  const roles = def.participants.roles.map((role) => ({ ...role }));
  const speaker = roles.find((role) => role.key === "speaker");
  const customised = roles.some((role) => role.key !== "speaker" && role.enabled);

  if (speaker && !customised) {
    speaker.enabled = true;
    speaker.min = form.minSpeakers ?? speaker.min;
    speaker.max = form.maxSpeakers ?? speaker.max;
  }

  return {
    ...def.participants,
    roles,
    maxTotal: def.participants.maxTotal ?? form.maxParticipantsTotal ?? null,
  };
}

/**
 * Every submission this person owns that counts against their cap. A form-level
 * limit counts within the form; the event default counts across the event
 * (screenshot p13_2). Withdrawn and soft-deleted rows never count.
 */
async function ownedSubmissions(event: EventRow, form: FormRow, personId: string) {
  const db = getDb();
  const scopedToForm = form.submissionLimit !== null && form.submissionLimit !== undefined;

  const rows = await db
    .select({ session: sessions })
    .from(sessions)
    .innerJoin(sessionParticipants, eq(sessionParticipants.sessionId, sessions.id))
    .where(
      and(
        eq(sessions.eventId, event.id),
        scopedToForm ? eq(sessions.formId, form.id) : eq(sessions.isAbstract, true),
        eq(sessionParticipants.personId, personId),
        eq(sessionParticipants.isPrimary, true),
        isNull(sessions.deletedAt),
        ne(sessions.status, "withdrawn"),
      ),
    )
    .orderBy(desc(sessions.updatedAt));

  return rows.map((row) => row.session);
}

/** The person's draft on THIS form, regardless of which scope the cap uses. */
export async function findDraft(
  eventId: string,
  formId: string,
  personId: string,
): Promise<DraftView | null> {
  const rows = await getDb()
    .select({ session: sessions })
    .from(sessions)
    .innerJoin(sessionParticipants, eq(sessionParticipants.sessionId, sessions.id))
    .where(
      and(
        eq(sessions.eventId, eventId),
        eq(sessions.formId, formId),
        eq(sessions.status, "draft"),
        eq(sessionParticipants.personId, personId),
        eq(sessionParticipants.isPrimary, true),
        isNull(sessions.deletedAt),
      ),
    )
    .orderBy(desc(sessions.updatedAt))
    .limit(1);

  return rows[0] ? toDraftView(rows[0].session) : null;
}

/** Look up a person by email without creating one — the account step needs to
 *  know whether an inline sign-up would silently take over an existing account. */
export async function findPersonByEmail(email: string): Promise<Person | null> {
  const row = await getDb().query.people.findFirst({
    where: eq(people.email, normalizeEmail(email)),
  });
  return row ?? null;
}

/** Fill in the split name fields after an inline sign-up. */
export async function updatePersonName(
  personId: string,
  firstName: string,
  lastName: string,
): Promise<void> {
  await getDb()
    .update(people)
    .set({ firstName, lastName, updatedAt: new Date() })
    .where(eq(people.id, personId));
}

/* ------------------------------------------------------------ draft writes */

/** `forms.target === "session"` goes straight to the program; everything else is an abstract. */
export function isAbstractForForm(form: Pick<FormRow, "target">): boolean {
  return form.target !== "session";
}

/**
 * Resume the person's draft or open a new one. Creating a draft writes the row
 * AND the primary-participant link in a single `db.batch` — the link is what
 * attributes drafts to their owner (there is no `created_by` column), so a
 * half-written pair would make the draft invisible to its creator.
 */
export async function ensureDraft(context: {
  event: EventRow;
  form: FormRow;
  def: FormDefinition;
  person: Person;
}): Promise<DraftView> {
  const existing = await findDraft(context.event.id, context.form.id, context.person.id);
  if (existing) return existing;

  const db = getDb();
  const id = crypto.randomUUID();
  const participants = [primaryFromPerson(context.person, context.def)];
  const draft: DraftView = {
    id,
    status: "draft",
    title: "Untitled submission",
    fields: {},
    participants,
    content: { ...EMPTY_CONTENT },
  };

  await db.batch([
    db.insert(sessions).values({
      id,
      eventId: context.event.id,
      formId: context.form.id,
      title: draft.title,
      status: "draft",
      isAbstract: isAbstractForForm(context.form),
      answers: draftBlob(draft),
    }),
    db.insert(sessionParticipants).values({
      sessionId: id,
      personId: context.person.id,
      role: primaryRole(context.def),
      isPrimary: true,
      order: 0,
    }),
  ]);

  return draft;
}

type ParticipantRoleColumn = NonNullable<
  (typeof sessionParticipants.$inferInsert)["role"]
>;

function primaryRole(def: FormDefinition): ParticipantRoleColumn {
  const enabled = def.participants.roles.find((role) => role.enabled);
  return (enabled?.key ?? "speaker") as ParticipantRoleColumn;
}

export function primaryFromPerson(person: Person, def: FormDefinition): DraftParticipant {
  const [first = "", ...rest] = (person.fullName ?? "").trim().split(/\s+/);
  return {
    role: primaryRole(def),
    firstName: person.firstName ?? first,
    lastName: person.lastName ?? rest.join(" "),
    email: person.email,
    bio: person.bio ?? "",
    isPrimary: true,
    answers: {},
  };
}

/** Persist the draft. Hidden fields are pruned, never stored. */
export async function saveDraft(input: {
  draftId: string;
  def: FormDefinition;
  fields: Record<string, AnswerValue>;
  participants: DraftParticipant[];
  content: DraftContent;
  /**
   * Eligible-track choice. Written every time, like `fields` and `content` —
   * callers on steps that do not edit it pass the draft's current value through
   * rather than omitting it, so a save can never half-persist a draft.
   */
  trackId?: string | null;
}): Promise<void> {
  const answers = toFormAnswers(input.fields, input.participants);
  const visible = new Set(visibleFields(answers, input.def).map((field) => field.key));
  const pruned: Record<string, AnswerValue> = {};
  for (const [key, value] of Object.entries(input.fields)) {
    if (visible.has(key)) pruned[key] = value;
  }

  await getDb()
    .update(sessions)
    .set({
      answers: draftBlob({ ...input, fields: pruned }),
      title: textOf(input.fields.title).trim() || "Untitled submission",
      updatedAt: new Date(),
    })
    .where(eq(sessions.id, input.draftId));
}

/* ---------------------------------------------------------------- uploads */

export interface UploadResult {
  ok: boolean;
  error: string | null;
  key: string | null;
  filename: string | null;
  size: number | null;
}

/**
 * THE UPLOAD SEAM — now wired to WS3's shared implementation.
 *
 * `POST /api/upload` (app/routes/api.upload.ts) is the one authenticated upload
 * endpoint; it is a thin auth wrapper around `storeUpload`, which owns the size
 * cap, the MIME allowlist and the "every object gets an owner" rule. The wizard
 * calls `storeUpload` directly rather than issuing a subrequest to its own
 * Worker: the route's ownership check answers "may this person attach to this
 * record?", and here the record IS the caller's own draft — resolved by a join
 * on `session_participants.person_id` before we get this far. Going over HTTP
 * would re-derive an answer we already hold, at the cost of a subrequest and
 * cookie forwarding.
 *
 * What matters is that the RULES have one implementation, and they do.
 *
 * ⚠️ WS3's allowlist for `purpose: "other"` is documents + images. A real video
 * file (video/mp4, video/quicktime) is rejected, so a video submission is a LINK
 * today and an upload only for slide-style files. Widening the allowlist is
 * WS3's call, not this lane's — reported to the orchestrator.
 */
export interface UploadResult {
  ok: boolean;
  error: string | null;
  key: string | null;
  filename: string | null;
  size: number | null;
}

export async function storeSubmissionUpload(input: {
  event: EventRow;
  draftId: string;
  personId: string;
  file: File;
}): Promise<UploadResult> {
  if (!input.file || input.file.size === 0) {
    return { ok: false, error: "Choose a file to upload.", key: null, filename: null, size: null };
  }

  const result = await storeUpload({
    file: input.file,
    eventId: input.event.id,
    ownerType: "session",
    ownerId: input.draftId,
    purpose: PUBLIC_SUBMIT_FILE_PURPOSE,
    uploadedById: input.personId,
  });

  if (!result.ok) {
    return { ok: false, error: result.error, key: null, filename: null, size: null };
  }
  return {
    ok: true,
    error: null,
    key: result.upload.key,
    filename: result.upload.filename,
    size: result.upload.sizeBytes,
  };
}

/* ----------------------------------------------------------------- submit */

/** Next `ABS-n` / `SESS-n` for the event. Drafts stay unnumbered until submit. */
async function nextFriendlyId(eventId: string, prefix: string): Promise<string> {
  const rows = await getDb()
    .select({ friendlyId: sessions.friendlyId })
    .from(sessions)
    .where(eq(sessions.eventId, eventId));

  let highest = 0;
  for (const row of rows) {
    const match = row.friendlyId?.match(new RegExp(`^${prefix}-(\\d+)$`));
    if (match) highest = Math.max(highest, Number(match[1]));
  }
  return `${prefix}-${highest + 1}`;
}

export type SubmitResult =
  | { ok: false; reason: "closed" }
  | { ok: false; reason: "ineligible_track"; message: string }
  | {
      ok: true;
      sessionId: string;
      friendlyId: string;
      /** `tracks.id` chosen by category routing, or null. */
      trackId: string | null;
      /** True when the confirmation email was actually handed to the mailer. */
      emailed: boolean;
    };

/**
 * Turn the draft into a real submission: `status: "pending"`, participants
 * materialised into `people` + `session_participants`, category routing applied,
 * then the confirmation email.
 *
 * The close state is re-read HERE, not taken from the caller: the route loaded
 * its context before the submitter filled anything in, and the authoritative
 * gate belongs next to the write. A closed form writes nothing and emails
 * nothing.
 *
 * All writes go out as ONE `db.batch`, so a submission never half-lands with a
 * status flip but no co-speakers.
 */
export async function submitDraft(input: {
  request: Request;
  event: EventRow;
  form: FormRow;
  def: FormDefinition;
  draft: DraftView;
  submitter: Person;
}): Promise<SubmitResult> {
  const db = getDb();
  const { draft, def } = input;

  const fresh = await db.query.forms.findFirst({
    where: and(
      eq(forms.id, input.form.id),
      eq(forms.eventId, input.event.id),
      eq(forms.surface, "cfp"),
    ),
  });
  const freshDef = fresh ? toFormDefinition(fresh) : null;
  const closed = freshDef ? closedReason(freshDef) : "not_open";
  if (closed) return { ok: false, reason: "closed" };

  /*
   * Eligible tracks are re-read from the FRESH row for the same reason the
   * close state is: the caller's definition was loaded before the submitter
   * filled anything in, and the authoritative gate belongs next to the write.
   *
   * This is also the gate a hand-built POST meets. The wizard step already
   * rejects a disallowed track, but "the step rejected it" is a property of the
   * step, not of the submission — a request that skips straight to submit, or a
   * draft blob edited between steps, arrives here and is refused before any row
   * changes status.
   */
  const eligible = checkEligibleTrack({
    eligibleTrackIds: freshDef!.eligibleTrackIds,
    chosen: draft.trackId,
  });
  if (!eligible.ok) return { ok: false, reason: "ineligible_track", message: eligible.error };

  const participants = draft.participants.length
    ? draft.participants
    : [primaryFromPerson(input.submitter, def)];

  // Resolve every participant email to a person id, creating the ones we have
  // never seen. Reads first, then a single batch of writes.
  const emails = participants.map((p) => normalizeEmail(p.email));
  const [existing, eventFormats, eventLevels] = await Promise.all([
    emails.length ? db.query.people.findMany({ where: inArray(people.email, emails) }) : [],
    db
      .select({ id: formats.id, name: formats.name })
      .from(formats)
      .where(eq(formats.eventId, input.event.id)),
    db
      .select({ id: levels.id, name: levels.name })
      .from(levels)
      .where(eq(levels.eventId, input.event.id)),
  ]);
  const byEmail = new Map(existing.map((row) => [row.email, row]));

  const statements: BatchStatement[] = [];

  const resolved = participants.map((participant) => {
    const email = normalizeEmail(participant.email);
    const known = byEmail.get(email);
    const personId = known?.id ?? crypto.randomUUID();
    const bio = (participant.bio ?? "").trim();

    if (!known) {
      statements.push(
        db.insert(people).values({
          id: personId,
          email,
          fullName: `${participant.firstName} ${participant.lastName}`.trim(),
          firstName: participant.firstName,
          lastName: participant.lastName,
          bio: bio || null,
          role: "speaker",
        }),
      );
    } else if (
      known.id === input.submitter.id &&
      bio &&
      !(known.bio ?? "").trim()
    ) {
      // Only the authenticated submitter may hydrate their own blank profile.
      // A participant email is not proof that the submitter controls that
      // co-speaker's account; letting it write the known person's global bio
      // would turn the participant picker into a cross-account mutation.
      statements.push(
        db.update(people).set({ bio, updatedAt: new Date() }).where(eq(people.id, personId)),
      );
    }
    return { participant, personId };
  });

  const existingMemberships = await db
    .select({ personId: eventPeople.personId, eventRole: eventPeople.eventRole })
    .from(eventPeople)
    .where(
      and(
        eq(eventPeople.eventId, input.event.id),
        inArray(
          eventPeople.personId,
          resolved.map((entry) => entry.personId),
        ),
      ),
    );
  const membershipByPersonId = new Map(
    existingMemberships.map((membership) => [membership.personId, membership]),
  );

  const answers = toFormAnswers(draft.fields, participants);
  const routed = routeCategory(answers, def);
  // The submitter's pick beats a routing rule on a form that asked them; on a
  // form that did not, routing is still the only source of a track.
  const trackId = resolveSubmittedTrack({
    eligibleTrackIds: freshDef!.eligibleTrackIds,
    chosen: draft.trackId,
    routed: routed.trackId,
  });
  const { formatId, levelId } = resolveFormatAndLevel({
    answers: draft.fields as Record<string, unknown>,
    formats: eventFormats,
    levels: eventLevels,
  });
  const prefix = isAbstractForForm(input.form) ? "ABS" : "SESS";
  const friendlyId = await nextFriendlyId(input.event.id, prefix);

  const title = textOf(draft.fields.title).trim() || draft.title;
  const description =
    ABSTRACT_KEYS.map((key) => textOf(draft.fields[key])).find((value) => value.trim()) ?? null;
  const submittedAt = new Date();

  statements.push(
    db
      .update(sessions)
      .set({
        status: "pending",
        friendlyId,
        title,
        description,
        // Stored flat and keyed by field key: that is what WS2's abstracts table
        // and WS7's API read. The wizard's own scaffolding does not survive.
        answers: draft.fields as Record<string, unknown>,
        // Routing and the submitter's eligible-track pick both resolve to a real
        // `tracks.id`, so the decision is stored where WS2's table and WS4's
        // agenda already read it.
        ...(trackId ? { trackId } : {}),
        // Public form options are names. Resolve them against this event's
        // metadata, and never replace an existing id when no unique match exists.
        ...(formatId ? { formatId } : {}),
        ...(levelId ? { levelId } : {}),
        videoUrl: draft.content.mode === "video" ? draft.content.videoUrl || null : null,
        externalUrl: draft.content.uploadKey,
        updatedAt: submittedAt,
      })
      .where(eq(sessions.id, draft.id)),
  );

  // The initial content snapshot belongs in the same atomic submission batch:
  // a successful status flip must never land without its submit attribution.
  statements.push(
    db.insert(sessionRevisions).values({
      id: crypto.randomUUID(),
      sessionId: draft.id,
      title,
      description,
      editorPersonId: input.submitter.id,
      editorName: input.submitter.fullName ?? input.submitter.email,
      source: "submit",
      createdAt: submittedAt,
    }),
  );

  // Rebuild the participant links from scratch: the composite PK is
  // (session, person, role), so an edited role would otherwise leave a stale row.
  statements.push(
    db.delete(sessionParticipants).where(eq(sessionParticipants.sessionId, draft.id)),
  );
  resolved.forEach((entry, index) => {
    statements.push(
      db.insert(sessionParticipants).values({
        sessionId: draft.id,
        personId: entry.personId,
        role: entry.participant.role as ParticipantRoleColumn,
        isPrimary: entry.personId === input.submitter.id,
        order: index,
      }),
    );
    const membership = membershipByPersonId.get(entry.personId);
    if (membership?.eventRole === "reviewer" || membership?.eventRole === "contact") {
      // Reviewer and contact memberships otherwise disappear from every
      // equality-based speaker surface after submitting. Organizer/admin roles
      // must keep their authority, while the independent reviewer flag must
      // survive so speaker promotion does not revoke review access.
      statements.push(
        db
          .update(eventPeople)
          .set({ eventRole: "speaker" })
          .where(
            and(
              eq(eventPeople.eventId, input.event.id),
              eq(eventPeople.personId, entry.personId),
              inArray(eventPeople.eventRole, ["reviewer", "contact"]),
            ),
          ),
      );
    } else if (!membership) {
      statements.push(
        db
          .insert(eventPeople)
          .values({ eventId: input.event.id, personId: entry.personId, eventRole: "speaker" })
          .onConflictDoNothing(),
      );
    }
  });

  await db.batch(statements as unknown as BatchArgument);

  // Red-annotated "must have". After the write, so a failed submission can never
  // produce a receipt.
  //
  // WS5: the copy comes from the event's editable `submission_confirmation`
  // template unless THIS form carries its own, and the send is wrapped so it
  // lands in the comm log — including when the provider rejects it.
  const template = await loadTemplate(input.event.id, "submission_confirmation", db);
  const sent = await sendSubmissionConfirmation(
    withCommLog(getMailer(), {
      eventId: input.event.id,
      personId: input.submitter.id,
      templateId: template.id,
      templateKey: "submission_confirmation",
      meta: { sessionId: draft.id, friendlyId },
      db,
    }),
    {
      to: input.submitter.email,
      speakerName: input.submitter.fullName,
      eventName: input.event.name,
      formName: input.form.name,
      submissionTitle: title,
      friendlyId,
      portalUrl: `${appUrl(input.request)}/portal`,
      config: def.settings.notifications.confirmationEmail,
      template,
      closed: false,
    },
  );

  return {
    ok: true,
    sessionId: draft.id,
    friendlyId,
    trackId,
    emailed: sent !== null,
  };
}
