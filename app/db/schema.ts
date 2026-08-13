/**
 * Callboard schema — PLAN.md §3, plus the WS0 schema deltas.
 *
 * Conventions (keep to these when a lane adds a table):
 * - Text UUID primary keys (`crypto.randomUUID()`), matching Sessionboard's public API.
 * - Timestamps are integer epoch-ms (`mode: "timestamp_ms"`) and surface as `Date` in TS.
 * - Enums are exported `const` tuples so routes/tests import the single source, never a literal.
 * - Everything event-scoped carries `event_id`; the API layer (WS7) filters on it.
 *
 * D1 note: there are NO interactive transactions. `db.transaction()` throws on the D1
 * driver — use `db.batch([...])` for atomic multi-statement writes (see app/db/client.server.ts).
 */
import { sql } from "drizzle-orm";
import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

/* ------------------------------------------------------------------ enums */

/**
 * Session/abstract status. Mirrors Sessionboard's CFP pipeline exactly
 * (research/sessionboard-api.md §3) plus `draft` and `withdrawn`.
 * `*_queue` are staging states: decide -> review batch -> commit.
 */
export const SESSION_STATUSES = [
  "draft",
  "pending",
  "accept_queue",
  "accepted",
  "decline_queue",
  "declined",
  "withdrawn",
] as const;
export type SessionStatus = (typeof SESSION_STATUSES)[number];

/** Which entity a form collects against. CFP forms are `submission`/`session`. */
export const FORM_TARGETS = ["submission", "session", "contact", "group"] as const;
export type FormTarget = (typeof FORM_TARGETS)[number];

export const FORM_STATUSES = ["draft", "open", "closed"] as const;
export type FormStatus = (typeof FORM_STATUSES)[number];

/** Field types in the per-event field registry. Immutable once a field is created. */
export const FIELD_TYPES = [
  "text",
  "textarea",
  "wysiwyg",
  "number",
  "email",
  "url",
  "phone",
  "select",
  "multiselect",
  "radio",
  "checkbox",
  "boolean",
  "date",
  "file",
  "video_url",
] as const;
export type FieldType = (typeof FIELD_TYPES)[number];

/** Which module a registry field attaches to. */
export const FIELD_MODULES = ["session", "contact", "group"] as const;
export type FieldModule = (typeof FIELD_MODULES)[number];

export const PERSON_ROLES = ["admin", "speaker"] as const;
export type PersonRole = (typeof PERSON_ROLES)[number];

export const SPEAKER_STATUSES = ["invited", "confirmed", "onboarding", "ready"] as const;
export type SpeakerStatus = (typeof SPEAKER_STATUSES)[number];

export const TASK_STATUSES = ["pending", "in_progress", "complete", "waived"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const COMM_STATUSES = ["queued", "sent", "failed", "bounced"] as const;
export type CommStatus = (typeof COMM_STATUSES)[number];

export const AUTH_TOKEN_PURPOSES = ["magic_link", "invite"] as const;
export type AuthTokenPurpose = (typeof AUTH_TOKEN_PURPOSES)[number];

/** Participant roles on a session. Flat `participants[]` model only (no legacy triple). */
export const PARTICIPANT_ROLES = [
  "speaker",
  "co_speaker",
  "chairperson",
  "moderator",
  "panelist",
] as const;
export type ParticipantRole = (typeof PARTICIPANT_ROLES)[number];

/** What an uploaded R2 object is attached to. Uploads are never orphaned. */
export const UPLOAD_OWNER_TYPES = ["person", "session"] as const;
export type UploadOwnerType = (typeof UPLOAD_OWNER_TYPES)[number];

export const UPLOAD_PURPOSES = ["headshot", "slides", "document", "other"] as const;
export type UploadPurpose = (typeof UPLOAD_PURPOSES)[number];

export const SYNC_PROVIDERS = ["airtable", "accelevents"] as const;
export type SyncProvider = (typeof SYNC_PROVIDERS)[number];

/** Fixed sourcing stages; ordering is product workflow, not organizer configuration. */
export const PIPELINE_STAGES = [
  "prospect",
  "contacted",
  "in_conversation",
  "confirmed",
  "declined",
] as const;
export type PipelineStage = (typeof PIPELINE_STAGES)[number];
export const PIPELINE_STAGE_LABELS: Record<PipelineStage, string> = {
  prospect: "Prospect",
  contacted: "Contacted",
  in_conversation: "In conversation",
  confirmed: "Confirmed",
  declined: "Declined",
};

export const REVISION_SOURCES = [
  "submit",
  "admin_edit",
  "portal_edit",
  "restore",
  "system",
] as const;
export type RevisionSource = (typeof REVISION_SOURCES)[number];

/* ------------------------------------------------------------- helpers */

const uuid = () =>
  text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID());

const createdAt = () =>
  integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .default(sql`(unixepoch() * 1000)`);

const updatedAt = () =>
  integer("updated_at", { mode: "timestamp_ms" })
    .notNull()
    .default(sql`(unixepoch() * 1000)`)
    .$onUpdateFn(() => new Date());

/* -------------------------------------------------------------- events */

export const events = sqliteTable(
  "events",
  {
    id: uuid(),
    name: text("name").notNull(),
    /** Drives the public CFP URL: /submit/<event-slug>/<form-id>. */
    slug: text("slug").notNull(),
    description: text("description"),
    location: text("location"),
    timezone: text("timezone").notNull().default("America/Los_Angeles"),
    startsOn: integer("starts_on", { mode: "timestamp_ms" }),
    endsOn: integer("ends_on", { mode: "timestamp_ms" }),
    /** Event-level cap on submissions per person; a form may override it. */
    submissionLimit: integer("submission_limit"),
    /** Free-form event settings (branding, feature toggles). */
    settings: text("settings", { mode: "json" }).$type<Record<string, unknown>>(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("events_slug_idx").on(t.slug)],
);

/* -------------------------------------------------------------- people */

export const people = sqliteTable(
  "people",
  {
    id: uuid(),
    email: text("email").notNull(),
    fullName: text("full_name"),
    firstName: text("first_name"),
    lastName: text("last_name"),
    pronouns: text("pronouns"),
    company: text("company"),
    title: text("title"),
    bio: text("bio"),
    /** Organizer-visible travel and logistics context for this global contact. */
    travelNotes: text("travel_notes"),
    /** Tombstone pointer for merged contacts; deliberately not a self-reference. */
    mergedInto: text("merged_into"),
    /** R2 object key for the headshot; the row in `uploads` holds the metadata. */
    headshotKey: text("headshot_key"),
    /**
     * Consent to show the headshot on PUBLIC surfaces (DECISIONS #57, revised).
     *
     * Default FALSE, and the default is the whole point: every headshot already
     * in the bucket was uploaded under a portal privacy expectation, so a
     * migration that flipped these to true would publish photos nobody agreed
     * to publish. It becomes true only by an act that carries consent — a
     * speaker uploading with the public-use notice on screen, an organizer
     * flipping the per-speaker toggle, or the synthetic demo seed.
     */
    photoPublishable: integer("photo_publishable", { mode: "boolean" })
      .notNull()
      .default(false),
    links: text("links", { mode: "json" }).$type<Record<string, string>>(),
    /** Global capability. Event-scoped participation lives in `event_people`. */
    role: text("role", { enum: PERSON_ROLES }).notNull().default("speaker"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("people_email_idx").on(t.email)],
);

/** Organizer-only notes attached to a global contact. */
export const contactNotes = sqliteTable(
  "contact_notes",
  {
    id: uuid(),
    personId: text("person_id")
      .notNull()
      .references(() => people.id, { onDelete: "cascade" }),
    authorId: text("author_id").references(() => people.id),
    body: text("body").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("contact_notes_person_idx").on(t.personId)],
);

/** Free-form organizer tags attached to a global contact. */
export const contactTags = sqliteTable(
  "contact_tags",
  {
    personId: text("person_id")
      .notNull()
      .references(() => people.id, { onDelete: "cascade" }),
    tag: text("tag").notNull(),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.personId, t.tag] })],
);

/**
 * A named, reusable view of the contact directory (CRM-09).
 *
 * The stored value is the directory's own querystring, not a parsed filter
 * tree. That is the whole design: the directory already turns a querystring
 * into a WHERE clause, so a segment is replayed by the code that produced it
 * and the two cannot drift. A second, parallel filter model would be a second
 * thing to keep correct.
 *
 * Organization-level like the directory it filters — no `event_id`. The name is
 * unique so saving over a segment updates it instead of leaving the organizer
 * with two chips that read the same.
 */
export const contactSegments = sqliteTable(
  "contact_segments",
  {
    id: uuid(),
    name: text("name").notNull(),
    /** Encoded `q=…&company=…`, WITHOUT the leading `?`. */
    querystring: text("querystring").notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("contact_segments_name_idx").on(t.name)],
);

/** One organization-level sourcing enrollment per active contact. */
export const pipelineEntries = sqliteTable(
  "pipeline_entries",
  {
    id: uuid(),
    personId: text("person_id")
      .notNull()
      .references(() => people.id, { onDelete: "cascade" }),
    stage: text("stage", { enum: PIPELINE_STAGES }).notNull().default("prospect"),
    position: integer("position").notNull().default(0),
    enrolledAt: integer("enrolled_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    score: integer("score"),
    rationale: text("rationale"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("pipeline_entries_person_idx").on(t.personId),
    index("pipeline_entries_stage_idx").on(t.stage),
  ],
);

/**
 * Sourcing-stage audit history deliberately has no FK from `entry_id` to
 * `pipeline_entries`: removing a contact from the pipeline tombstones the
 * history, so organizers can see that the contact was worked and dropped. A
 * re-enrollment gets a fresh entry id whose log sits beside the old one; a FK
 * would cascade-delete that audit trail, defeating the reason it is retained.
 */
export const stageTransitions = sqliteTable(
  "stage_transitions",
  {
    id: uuid(),
    entryId: text("entry_id").notNull(),
    personId: text("person_id")
      .notNull()
      .references(() => people.id, { onDelete: "cascade" }),
    fromStage: text("from_stage", { enum: PIPELINE_STAGES }),
    toStage: text("to_stage", { enum: PIPELINE_STAGES }).notNull(),
    movedByPersonId: text("moved_by_person_id").references(() => people.id),
    createdAt: createdAt(),
  },
  (t) => [
    index("stage_transitions_person_idx").on(t.personId),
    index("stage_transitions_entry_idx").on(t.entryId),
  ],
);

/** Contact <-> event association (Sessionboard's contact.event.associated). */
export const eventPeople = sqliteTable(
  "event_people",
  {
    eventId: text("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    personId: text("person_id")
      .notNull()
      .references(() => people.id, { onDelete: "cascade" }),
    /**
     * Per-event role label, e.g. "speaker", "reviewer", "organizer".
     *
     * Exactly ONE value per person per event — the primary key below is
     * `(event_id, person_id)`, so this column cannot hold two roles and must
     * never be repurposed to try. Speaker-scoped surfaces read it by equality
     * (`admin.tasks` speaker roster, `comms/bulk` audiences), which is why
     * reviewer capability is a separate column rather than a value here.
     */
    eventRole: text("event_role").notNull().default("speaker"),
    /**
     * May this person review abstracts on this event?
     *
     * Additive on purpose. Promoting a speaker by overwriting `event_role`
     * removed them from every surface that filters `event_role = 'speaker'`:
     * they vanished from the task-assignee roster and stopped matching any
     * `comms/bulk` audience, so an accepted speaker who agreed to review would
     * silently stop receiving their own logistics email. A flag grants the new
     * capability without withdrawing the old role.
     */
    isReviewer: integer("is_reviewer", { mode: "boolean" }).notNull().default(false),
    /** Per-event speaker workflow; identity/profile data remains global. */
    status: text("status", { enum: SPEAKER_STATUSES }).notNull().default("invited"),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.eventId, t.personId] }),
    index("event_people_person_idx").on(t.personId),
  ],
);

/* ---------------------------------------------------------------- auth */

/**
 * Magic-link tokens. Only the HMAC hash is stored, never the token.
 * Multi-use inside the TTL on purpose: email link prefetchers (Outlook Safe Links,
 * Gmail image proxy) consume single-use tokens before the human clicks.
 * `consumedAt` records first use; `useCount` bounds abuse.
 */
export const authTokens = sqliteTable(
  "auth_tokens",
  {
    id: uuid(),
    personId: text("person_id")
      .notNull()
      .references(() => people.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    purpose: text("purpose", { enum: AUTH_TOKEN_PURPOSES })
      .notNull()
      .default("magic_link"),
    /** Where to land the user after verification. */
    redirectTo: text("redirect_to"),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    consumedAt: integer("consumed_at", { mode: "timestamp_ms" }),
    useCount: integer("use_count").notNull().default(0),
    revokedAt: integer("revoked_at", { mode: "timestamp_ms" }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("auth_tokens_hash_idx").on(t.tokenHash),
    index("auth_tokens_person_idx").on(t.personId),
  ],
);

/**
 * Web sessions (browser login). Named `sessions_auth` because `sessions` is the
 * CFP/agenda resource — PLAN.md §3 calls this out.
 */
export const sessionsAuth = sqliteTable(
  "sessions_auth",
  {
    id: uuid(),
    personId: text("person_id")
      .notNull()
      .references(() => people.id, { onDelete: "cascade" }),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    lastSeenAt: integer("last_seen_at", { mode: "timestamp_ms" }),
    userAgent: text("user_agent"),
    revokedAt: integer("revoked_at", { mode: "timestamp_ms" }),
    createdAt: createdAt(),
  },
  (t) => [index("sessions_auth_person_idx").on(t.personId)],
);

/* -------------------------------------------------------- rate limits */

/**
 * Fixed-window counters for application-level public-write abuse controls.
 * Identifiers are opaque HMAC digests; raw email, person, and IP values are
 * never stored here.
 */
export const rateLimitWindows = sqliteTable(
  "rate_limit_windows",
  {
    scope: text("scope").notNull(),
    identifierHash: text("identifier_hash").notNull(),
    windowStart: integer("window_start").notNull(),
    windowCount: integer("window_count").notNull().default(0),
    expiresAt: integer("expires_at").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.scope, t.identifierHash, t.windowStart] }),
    index("rate_limit_windows_expires_idx").on(t.expiresAt),
  ],
);

/* ------------------------------------------------ metadata families */
/*
 * Five near-identical per-event families. Sessionboard serves these through one
 * generic handler (research/sessionboard-api.md §6 #13) — so does WS7, via the
 * `metadataTables` map exported at the bottom of this file. They stay separate
 * tables because rooms carry capacity and tracks carry colour.
 */

export const rooms = sqliteTable(
  "rooms",
  {
    id: uuid(),
    eventId: text("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    capacity: integer("capacity"),
    order: integer("order").notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("rooms_event_name_idx").on(t.eventId, t.name)],
);

export const tracks = sqliteTable(
  "tracks",
  {
    id: uuid(),
    eventId: text("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    color: text("color"),
    order: integer("order").notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("tracks_event_name_idx").on(t.eventId, t.name)],
);

export const tags = sqliteTable(
  "tags",
  {
    id: uuid(),
    eventId: text("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    order: integer("order").notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("tags_event_name_idx").on(t.eventId, t.name)],
);

export const formats = sqliteTable(
  "formats",
  {
    id: uuid(),
    eventId: text("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    /** Default length in minutes — the agenda builder uses it when dropping a session. */
    defaultMinutes: integer("default_minutes"),
    order: integer("order").notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("formats_event_name_idx").on(t.eventId, t.name)],
);

export const levels = sqliteTable(
  "levels",
  {
    id: uuid(),
    eventId: text("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    order: integer("order").notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("levels_event_name_idx").on(t.eventId, t.name)],
);

/* ------------------------------------------------- field registry */

/**
 * Per-event field registry. CFP forms, portal forms, and admin table column
 * config all reference these definitions rather than inlining field defs, so a
 * field means the same thing everywhere. `type` is immutable after creation
 * (enforced in the app layer — SQLite cannot express it).
 *
 * DECISIONS.md #9: per-event library, not Sessionboard's org-level shared
 * definitions with per-event overrides.
 */
export const fields = sqliteTable(
  "fields",
  {
    id: uuid(),
    eventId: text("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    module: text("module", { enum: FIELD_MODULES }).notNull().default("session"),
    /** Stable machine key used in form answer JSON. Unique per event+module. */
    key: text("key").notNull(),
    label: text("label").notNull(),
    helpText: text("help_text"),
    type: text("type", { enum: FIELD_TYPES }).notNull(),
    /** { required, min, max, minLength, maxLength, pattern, options[], accept[] } */
    constraints: text("constraints", { mode: "json" }).$type<Record<string, unknown>>(),
    /** Locked fields ship with the product and cannot be deleted by admins. */
    isLocked: integer("is_locked", { mode: "boolean" }).notNull().default(false),
    order: integer("order").notNull().default(0),
    archivedAt: integer("archived_at", { mode: "timestamp_ms" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("fields_event_module_key_idx").on(t.eventId, t.module, t.key)],
);

/* --------------------------------------------------------------- forms */

export const forms = sqliteTable(
  "forms",
  {
    id: uuid(),
    eventId: text("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    /**
     * Chosen at build time and never changed:
     * `submission` -> evaluated CFP abstract; `session` -> guaranteed slot
     * (sponsors) straight onto the agenda; `contact`/`group` -> portal forms.
     */
    target: text("target", { enum: FORM_TARGETS }).notNull().default("submission"),
    /**
     * Which product surface owns the form: `cfp` (public wizard) or `portal`
     * (speaker-portal forms/tasks). Replaces the `settings.surface` inference
     * WS3 shipped (see isPortalForm()).
     */
    surface: text("surface", { enum: ["cfp", "portal"] }).notNull().default("cfp"),
    status: text("status", { enum: FORM_STATUSES }).notNull().default("draft"),
    welcomeTitle: text("welcome_title"),
    welcomeBody: text("welcome_body"),
    thankYouBody: text("thank_you_body"),
    /**
     * Ordered field list + conditional-logic rules + category-routing rules.
     * Entries reference `fields.id`; WS1 owns the exact shape.
     */
    schema: text("schema", { mode: "json" })
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    /** Everything not worth a column: reminder cadence, admin notification list, theme. */
    settings: text("settings", { mode: "json" })
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    /** DECISIONS.md #7 — a min of 2 broke the incumbent product's own demo on camera. */
    minSpeakers: integer("min_speakers").notNull().default(1),
    maxSpeakers: integer("max_speakers"),
    /** Cap across all participant roles, shown live in the public form. */
    maxParticipantsTotal: integer("max_participants_total"),
    closesAt: integer("closes_at", { mode: "timestamp_ms" }),
    /** Per-person cap; overrides `events.submission_limit` when set. */
    submissionLimit: integer("submission_limit"),
    allowMultipleDrafts: integer("allow_multiple_drafts", { mode: "boolean" })
      .notNull()
      .default(true),
    reminderTemplateId: text("reminder_template_id"),
    thankYouTemplateId: text("thank_you_template_id"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("forms_event_idx").on(t.eventId)],
);

/* ------------------------------------------------------------ sessions */

/**
 * The core resource. Abstracts (CFP submissions) and program sessions are ONE
 * table discriminated by `is_abstract`, which is immutable after create —
 * mirroring Sessionboard's own model (DECISIONS.md #3).
 *
 * Times and capacity live on the BASE record: the Agenda is a view over rows
 * that have `starts_at` set, not a separate entity.
 */
export const sessions = sqliteTable(
  "sessions",
  {
    id: uuid(),
    eventId: text("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    /** Human-facing short id, e.g. SESS-8. Unique per event. */
    friendlyId: text("friendly_id"),
    title: text("title").notNull(),
    description: text("description"),
    status: text("status", { enum: SESSION_STATUSES }).notNull().default("pending"),
    /** Immutable after insert. true = CFP abstract, false = program session. */
    isAbstract: integer("is_abstract", { mode: "boolean" }).notNull().default(false),
    /** Which form produced this row (abstracts only). */
    formId: text("form_id").references(() => forms.id, { onDelete: "set null" }),
    /** Answers keyed by `fields.key`. */
    answers: text("answers", { mode: "json" }).$type<Record<string, unknown>>(),
    /** Submissions may be an abstract or a video (PLAN.md §4 WS1). */
    videoUrl: text("video_url"),
    externalUrl: text("external_url"),
    trackId: text("track_id").references(() => tracks.id, { onDelete: "set null" }),
    roomId: text("room_id").references(() => rooms.id, { onDelete: "set null" }),
    formatId: text("format_id").references(() => formats.id, { onDelete: "set null" }),
    levelId: text("level_id").references(() => levels.id, { onDelete: "set null" }),
    startsAt: integer("starts_at", { mode: "timestamp_ms" }),
    endsAt: integer("ends_at", { mode: "timestamp_ms" }),
    capacity: integer("capacity"),
    /** Visible on the public agenda/gallery. */
    isPublic: integer("is_public", { mode: "boolean" }).notNull().default(false),
    publishedAt: integer("published_at", { mode: "timestamp_ms" }),
    /**
     * When the speaker was successfully told this session is happening — i.e. the
     * ACCEPT decision letter left the building for every speaker on the originating
     * abstract. Null means "not told yet"; publishing holds until it is set, unless
     * an organizer explicitly overrides.
     */
    speakerInformedAt: integer("speaker_informed_at", { mode: "timestamp_ms" }),
    /** Accept path: an abstract is composed INTO the program session it becomes. */
    composedIntoSessionId: text("composed_into_session_id"),
    /** Soft delete + /restore, matching Sessionboard. */
    deletedAt: integer("deleted_at", { mode: "timestamp_ms" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("sessions_event_idx").on(t.eventId),
    index("sessions_event_abstract_status_idx").on(t.eventId, t.isAbstract, t.status),
    index("sessions_event_starts_idx").on(t.eventId, t.startsAt),
    index("sessions_room_starts_idx").on(t.roomId, t.startsAt),
    index("sessions_composed_idx").on(t.composedIntoSessionId),
    uniqueIndex("sessions_event_friendly_idx").on(t.eventId, t.friendlyId),
  ],
);

/** Flat participants model with configurable roles (no legacy speaker/chair/mod triple). */
export const sessionParticipants = sqliteTable(
  "session_participants",
  {
    sessionId: text("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    personId: text("person_id")
      .notNull()
      .references(() => people.id, { onDelete: "cascade" }),
    role: text("role", { enum: PARTICIPANT_ROLES }).notNull().default("speaker"),
    /** True for the person who submitted the abstract. */
    isPrimary: integer("is_primary", { mode: "boolean" }).notNull().default(false),
    order: integer("order").notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.sessionId, t.personId, t.role] }),
    index("session_participants_person_idx").on(t.personId),
  ],
);

/**
 * Append-only snapshots of session content and its editor attribution. Restoring
 * a snapshot writes a NEW revision after re-applying its content; it never
 * mutates or deletes any existing history row.
 */
export const sessionRevisions = sqliteTable(
  "session_revisions",
  {
    id: uuid(),
    sessionId: text("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    description: text("description"),
    // Nullable FK: the editing person may later be deleted/merged, and history
    // must survive that. `editorName` is a SNAPSHOT taken at write time so the
    // panel still attributes the edit when the person row is gone.
    editorPersonId: text("editor_person_id").references(() => people.id, {
      onDelete: "set null",
    }),
    editorName: text("editor_name").notNull(),
    source: text("source", { enum: REVISION_SOURCES }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("session_revisions_session_idx").on(t.sessionId, t.createdAt)],
);

export const sessionTags = sqliteTable(
  "session_tags",
  {
    sessionId: text("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    tagId: text("tag_id")
      .notNull()
      .references(() => tags.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.sessionId, t.tagId] })],
);

/* ----------------------------------------------------- review pipeline */

export const reviewRounds = sqliteTable(
  "review_rounds",
  {
    id: uuid(),
    eventId: text("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    ordinal: integer("ordinal").notNull().default(1),
    /** { criteria: [{ key, label, min, max, weight }], scale } */
    rubric: text("rubric", { mode: "json" }).$type<Record<string, unknown>>(),
    /** PLAN.md: AI-assist is a stretch behind a per-round toggle (DECISIONS.md #4). */
    aiAssist: integer("ai_assist", { mode: "boolean" }).notNull().default(false),
    opensAt: integer("opens_at", { mode: "timestamp_ms" }),
    closesAt: integer("closes_at", { mode: "timestamp_ms" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("review_rounds_event_ordinal_idx").on(t.eventId, t.ordinal)],
);

export const reviewTeams = sqliteTable(
  "review_teams",
  {
    id: uuid(),
    eventId: text("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("review_teams_event_name_idx").on(t.eventId, t.name)],
);

export const reviewTeamMembers = sqliteTable(
  "review_team_members",
  {
    teamId: text("team_id")
      .notNull()
      .references(() => reviewTeams.id, { onDelete: "cascade" }),
    personId: text("person_id")
      .notNull()
      .references(() => people.id, { onDelete: "cascade" }),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.teamId, t.personId] })],
);

/** Batches assign abstracts to TEAMS, not individual reviewers (walkthrough video). */
export const reviewAssignments = sqliteTable(
  "review_assignments",
  {
    id: uuid(),
    roundId: text("round_id")
      .notNull()
      .references(() => reviewRounds.id, { onDelete: "cascade" }),
    sessionId: text("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    teamId: text("team_id")
      .notNull()
      .references(() => reviewTeams.id, { onDelete: "cascade" }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("review_assignments_round_session_team_idx").on(
      t.roundId,
      t.sessionId,
      t.teamId,
    ),
    index("review_assignments_session_idx").on(t.sessionId),
  ],
);

export const reviews = sqliteTable(
  "reviews",
  {
    id: uuid(),
    roundId: text("round_id")
      .notNull()
      .references(() => reviewRounds.id, { onDelete: "cascade" }),
    sessionId: text("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    reviewerId: text("reviewer_id")
      .notNull()
      .references(() => people.id, { onDelete: "cascade" }),
    /** { [criterionKey]: number | selected option string } */
    scores: text("scores", { mode: "json" }).$type<Record<string, number | string>>(),
    /** Weighted total, denormalised for sorting the abstracts table. */
    totalScore: integer("total_score"),
    comment: text("comment"),
    /** Set when the review came from the AI-assist toggle rather than a human. */
    isAiSuggested: integer("is_ai_suggested", { mode: "boolean" }).notNull().default(false),
    submittedAt: integer("submitted_at", { mode: "timestamp_ms" }),
    /** Set when this reviewer declared a conflict; the row is a recusal, not a review. */
    recusedAt: integer("recused_at", { mode: "timestamp_ms" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("reviews_round_session_reviewer_idx").on(t.roundId, t.sessionId, t.reviewerId),
    index("reviews_session_idx").on(t.sessionId),
  ],
);

/* ------------------------------------------------------------ ai triage */

/*
 * Re-exported, not declared: these two tuples are written in
 * `app/lib/review/ai-triage.ts` so a route COMPONENT can read them without
 * pulling drizzle's sqlite-core into the browser bundle. The schema keeps the
 * "enums are an exported const tuple with one source" property either way.
 */
/*
 * RELATIVE, not the `~/` alias. `drizzle-kit generate` loads this file outside
 * Vite and cannot resolve `~/…`; it printed "Cannot find module
 * '~/lib/review/ai-triage'" and still exited 0, so `npm run migrations:check`
 * reported "ok: migrations are up to date" while generating nothing at all.
 * A green that measures nothing is worse than a red. See the exit-code guard
 * added to scripts/check-migrations.mjs alongside this.
 */
import { AI_TRIAGE_RECOMMENDATIONS, AI_TRIAGE_STATUSES } from "../lib/review/ai-triage";

export {
  AI_TRIAGE_RECOMMENDATIONS,
  AI_TRIAGE_STATUSES,
  type AiTriageRecommendation,
  type AiTriageStatus,
} from "../lib/review/ai-triage";

/**
 * AI-assisted FIRST PASS on a submission — advisory only.
 *
 * Deliberately its OWN table rather than a `reviews` row carrying
 * `is_ai_suggested`. A model opinion in `reviews` would flow into
 * `aggregateFor()`, the abstracts table's aggregate column, the score sort and
 * the reviewer CSV's human columns the moment anybody forgot the flag — the
 * separation is the guarantee, not a filter somebody has to remember. Nothing
 * in `app/lib/review/aggregate.ts` can even see this table.
 *
 * One row per submission (`session_id` unique): re-running replaces the row, so
 * the card shows the latest opinion and never a growing pile of them. A
 * malformed model response is STORED (`status = "failed"`, raw text in
 * `reasoning`) rather than thrown away — a visible failure beats a silent one.
 */
export const aiTriage = sqliteTable(
  "ai_triage",
  {
    id: uuid(),
    eventId: text("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    sessionId: text("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    /** 1–5, null on a failed attempt. */
    score: integer("score"),
    recommendation: text("recommendation", { enum: AI_TRIAGE_RECOMMENDATIONS }),
    /** 2–4 sentences on success; the raw model text on a failure. */
    reasoning: text("reasoning"),
    /** The model id the opinion came from, shown verbatim in the UI label. */
    model: text("model").notNull(),
    status: text("status", { enum: AI_TRIAGE_STATUSES }).notNull().default("ok"),
    /** The admin who pressed the button; null for seeded example rows. */
    requestedById: text("requested_by_id").references(() => people.id, {
      onDelete: "set null",
    }),
    dismissedAt: integer("dismissed_at", { mode: "timestamp_ms" }),
    organizerScore: integer("organizer_score"),
    organizerNote: text("organizer_note"),
    organizerScoredById: text("organizer_scored_by_id").references(() => people.id, {
      onDelete: "set null",
    }),
    organizerScoredAt: integer("organizer_scored_at", { mode: "timestamp_ms" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("ai_triage_session_idx").on(t.sessionId),
    index("ai_triage_event_idx").on(t.eventId),
  ],
);

/* --------------------------------------------------------------- tasks */

export const taskTemplates = sqliteTable(
  "task_templates",
  {
    id: uuid(),
    eventId: text("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    description: text("description"),
    /** A task can embed a form (portal forms target contact/group). */
    formId: text("form_id").references(() => forms.id, { onDelete: "set null" }),
    /** Due date relative to acceptance, in days. Absolute dates go on the task. */
    dueOffsetDays: integer("due_offset_days"),
    isRequired: integer("is_required", { mode: "boolean" }).notNull().default(true),
    order: integer("order").notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("task_templates_event_idx").on(t.eventId)],
);

export const tasks = sqliteTable(
  "tasks",
  {
    id: uuid(),
    eventId: text("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    templateId: text("template_id").references(() => taskTemplates.id, {
      onDelete: "set null",
    }),
    personId: text("person_id")
      .notNull()
      .references(() => people.id, { onDelete: "cascade" }),
    /** Some tasks are per-session (upload slides for THIS talk). */
    sessionId: text("session_id").references(() => sessions.id, { onDelete: "cascade" }),
    /** What completes it: `manual` checkbox, `form` fill, or file `upload`. */
    kind: text("kind", { enum: ["manual", "form", "upload"] }).notNull().default("manual"),
    /** Who actually completed it — differs from personId under impersonation. */
    completedById: text("completed_by_id").references(() => people.id, {
      onDelete: "set null",
    }),
    title: text("title").notNull(),
    description: text("description"),
    formId: text("form_id").references(() => forms.id, { onDelete: "set null" }),
    status: text("status", { enum: TASK_STATUSES }).notNull().default("pending"),
    dueAt: integer("due_at", { mode: "timestamp_ms" }),
    completedAt: integer("completed_at", { mode: "timestamp_ms" }),
    /** Answers when the task embeds a form. */
    response: text("response", { mode: "json" }).$type<Record<string, unknown>>(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("tasks_event_person_idx").on(t.eventId, t.personId),
    index("tasks_event_status_idx").on(t.eventId, t.status),
  ],
);

/* --------------------------------------------------------------- comms */

export const emailTemplates = sqliteTable(
  "email_templates",
  {
    id: uuid(),
    eventId: text("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    /** Stable key for automated sends: "acceptance", "task_reminder", "magic_link". */
    key: text("key").notNull(),
    name: text("name").notNull(),
    subject: text("subject").notNull(),
    /** Markdown with {{merge_fields}}. */
    body: text("body").notNull(),
    fromName: text("from_name"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("email_templates_event_key_idx").on(t.eventId, t.key)],
);

export const commLog = sqliteTable(
  "comm_log",
  {
    id: uuid(),
    eventId: text("event_id").references(() => events.id, { onDelete: "cascade" }),
    personId: text("person_id").references(() => people.id, { onDelete: "set null" }),
    templateId: text("template_id").references(() => emailTemplates.id, {
      onDelete: "set null",
    }),
    channel: text("channel").notNull().default("email"),
    toEmail: text("to_email").notNull(),
    subject: text("subject").notNull(),
    status: text("status", { enum: COMM_STATUSES }).notNull().default("queued"),
    providerMessageId: text("provider_message_id"),
    error: text("error"),
    /** e.g. { hasIcs: true, sessionId: "..." } */
    meta: text("meta", { mode: "json" }).$type<Record<string, unknown>>(),
    sentAt: integer("sent_at", { mode: "timestamp_ms" }),
    createdAt: createdAt(),
  },
  (t) => [
    index("comm_log_event_idx").on(t.eventId),
    index("comm_log_person_idx").on(t.personId),
  ],
);

/* ----------------------------------------------------------- resources */

export const resources = sqliteTable(
  "resources",
  {
    id: uuid(),
    eventId: text("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    slug: text("slug").notNull(),
    title: text("title").notNull(),
    body: text("body"),
    /** Sanitised raw-HTML embed block (PLAN.md §10 cut line). */
    htmlEmbed: text("html_embed"),
    isPublished: integer("is_published", { mode: "boolean" }).notNull().default(false),
    order: integer("order").notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("resources_event_slug_idx").on(t.eventId, t.slug)],
);

/* ------------------------------------------------------------- uploads */

/**
 * R2 objects. Always attached to a record — `ownerType`/`ownerId` are NOT NULL,
 * so an upload cannot be orphaned. Polymorphic, so no FK: integrity is enforced
 * by the upload route, which resolves the owner before writing to R2.
 * Uploads are proxied through the Worker (25 MB cap) — no presigned URLs.
 */
export const uploads = sqliteTable(
  "uploads",
  {
    id: uuid(),
    eventId: text("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    ownerType: text("owner_type", { enum: UPLOAD_OWNER_TYPES }).notNull(),
    ownerId: text("owner_id").notNull(),
    purpose: text("purpose", { enum: UPLOAD_PURPOSES }).notNull().default("other"),
    /** R2 object key. */
    key: text("key").notNull(),
    filename: text("filename").notNull(),
    contentType: text("content_type").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    uploadedById: text("uploaded_by_id").references(() => people.id, {
      onDelete: "set null",
    }),
    /**
     * Version chain root. NULL on v1; every later upload against the same slot
     * stores the id of the FIRST upload in the chain (never the immediately
     * previous one), so a chain is one indexed query — `id = root OR
     * version_of = root` — rather than a walk whose length is unbounded.
     *
     * Deliberately no FK: deleting a root must not cascade away the versions
     * that came after it, because their R2 objects would then be unreachable
     * rather than deleted. A chain whose root row is gone still lists.
     */
    versionOf: text("version_of"),
    /**
     * 1-based position in the chain, stamped at insert.
     *
     * Ordering by `created_at` is NOT sufficient: the column defaults to
     * `unixepoch() * 1000`, which is SECOND resolution, so two uploads in the
     * same second are indistinguishable and "which one is Latest" would depend
     * on row order. An explicit counter is the only version number that is
     * still right a second later.
     */
    version: integer("version").notNull().default(1),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("uploads_key_idx").on(t.key),
    index("uploads_owner_idx").on(t.ownerType, t.ownerId),
    index("uploads_version_idx").on(t.versionOf),
  ],
);

/**
 * Comments attached to an uploaded file, readable by both sides.
 *
 * `uploadId` always points at the CHAIN ROOT (`uploads.version_of ?? id`), so
 * uploading v2 does not strand the conversation on v1 — organizer and speaker
 * see one thread per deliverable, not one per version.
 */
export const uploadComments = sqliteTable(
  "upload_comments",
  {
    id: uuid(),
    uploadId: text("upload_id")
      .notNull()
      .references(() => uploads.id, { onDelete: "cascade" }),
    authorId: text("author_id").references(() => people.id, { onDelete: "set null" }),
    /** Denormalised so a deleted person's comment still shows an author. */
    authorName: text("author_name").notNull(),
    body: text("body").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("upload_comments_upload_idx").on(t.uploadId)],
);

/* ------------------------------------------------------- api + sync */

export const apiKeys = sqliteTable(
  "api_keys",
  {
    id: uuid(),
    eventId: text("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    /** SHA-256 of the key; the plaintext is shown once at creation. */
    keyHash: text("key_hash").notNull(),
    /** Last 4 chars, for identifying a key in the UI. */
    keySuffix: text("key_suffix").notNull(),
    /** Sessionboard-style non-cascading scopes: ["read:sessions", "write:sessions"]. */
    scopes: text("scopes", { mode: "json" }).$type<string[]>().notNull().default([]),
    lastUsedAt: integer("last_used_at", { mode: "timestamp_ms" }),
    revokedAt: integer("revoked_at", { mode: "timestamp_ms" }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("api_keys_hash_idx").on(t.keyHash)],
);

export const syncState = sqliteTable(
  "sync_state",
  {
    id: uuid(),
    eventId: text("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    provider: text("provider", { enum: SYNC_PROVIDERS }).notNull(),
    /** Opaque cursor/watermark for the one-way mirror. */
    cursor: text("cursor"),
    lastSyncedAt: integer("last_synced_at", { mode: "timestamp_ms" }),
    lastError: text("last_error"),
    /** Idempotency map: local id -> remote id. */
    state: text("state", { mode: "json" }).$type<Record<string, unknown>>(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("sync_state_event_provider_idx").on(t.eventId, t.provider)],
);

/** Organization-level outbound webhook endpoints. Endpoint secrets are never listed. */
export const webhooks = sqliteTable(
  "webhooks",
  {
    id: uuid(),
    url: text("url").notNull(),
    /** Plaintext is required to sign future deliveries; expose only on create. */
    secret: text("secret").notNull(),
    active: integer("active", { mode: "boolean" }).notNull().default(true),
    createdAt: createdAt(),
  },
  (t) => [index("webhooks_active_idx").on(t.active)],
);

/** One final delivery outcome per local endpoint/event, or one Svix handoff. */
export const webhookDeliveries = sqliteTable(
  "webhook_deliveries",
  {
    id: uuid(),
    /** NULL in Svix mode because Svix, rather than Callboard, owns endpoints. */
    webhookId: text("webhook_id").references(() => webhooks.id, {
      onDelete: "set null",
    }),
    driver: text("driver", { enum: ["builtin", "svix"] }).notNull(),
    event: text("event").notNull(),
    resourceId: text("resource_id").notNull(),
    status: text("status", { enum: ["success", "failed"] }).notNull(),
    attempts: integer("attempts").notNull().default(1),
    lastError: text("last_error"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("webhook_deliveries_created_idx").on(t.createdAt),
    index("webhook_deliveries_webhook_idx").on(t.webhookId),
  ],
);

/* ------------------------------------------------------------ exports */

/**
 * The five generic metadata families, for WS7's single generic REST handler
 * (`/v1/event/{eventId}/{rooms,tracks,tags,formats,levels}`).
 */
export const metadataTables = {
  rooms,
  tracks,
  tags,
  formats,
  levels,
} as const;

export type MetadataFamily = keyof typeof metadataTables;
export const METADATA_FAMILIES = Object.keys(metadataTables) as MetadataFamily[];

export type Event = typeof events.$inferSelect;
export type NewEvent = typeof events.$inferInsert;
export type Person = typeof people.$inferSelect;
export type NewPerson = typeof people.$inferInsert;
export type PipelineEntry = typeof pipelineEntries.$inferSelect;
export type NewPipelineEntry = typeof pipelineEntries.$inferInsert;
export type StageTransition = typeof stageTransitions.$inferSelect;
export type NewStageTransition = typeof stageTransitions.$inferInsert;
export type Form = typeof forms.$inferSelect;
export type NewForm = typeof forms.$inferInsert;
export type Field = typeof fields.$inferSelect;
export type NewField = typeof fields.$inferInsert;
export type Session = typeof sessions.$inferSelect;
export type NewSession = typeof sessions.$inferInsert;
export type Task = typeof tasks.$inferSelect;
export type NewTask = typeof tasks.$inferInsert;
export type Review = typeof reviews.$inferSelect;
export type NewReview = typeof reviews.$inferInsert;
export type AiTriageRow = typeof aiTriage.$inferSelect;
export type NewAiTriageRow = typeof aiTriage.$inferInsert;
export type AuthToken = typeof authTokens.$inferSelect;
export type WebSession = typeof sessionsAuth.$inferSelect;
export type Upload = typeof uploads.$inferSelect;
export type UploadComment = typeof uploadComments.$inferSelect;
export type Webhook = typeof webhooks.$inferSelect;
export type WebhookDelivery = typeof webhookDeliveries.$inferSelect;
