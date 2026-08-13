/**
 * Wire serializers for `/v1`. PURE — takes plain rows, returns plain JSON.
 *
 * Shapes follow research/sessionboard-api.md §3 closely enough that a client
 * written against their `Session` / `Contact` schemas keeps working, with two
 * deliberate corrections:
 *
 * 1. **Unassigned metadata is `null`, never `{}`.** Sessionboard returns `{}` on
 *    POST search and `null` on the CRUD proxy for the same absent track (§8.3) —
 *    a guaranteed null-check bug in every client. One value, everywhere.
 * 2. **No legacy `speakers[]`/`chairpersons[]`/`moderators[]` triple**
 *    (DECISIONS.md #20). Only the flat `participants[]` model, which is what
 *    their own docs tell you to read.
 */
import type { ParticipantRole, SessionStatus } from "~/db/schema";

/* ------------------------------------------------------------- metadata */

export interface MetadataInput {
  id: string;
  name: string;
  order: number;
  color?: string | null;
  capacity?: number | null;
  defaultMinutes?: number | null;
  createdAt?: Date | null;
  updatedAt?: Date | null;
}

export interface MetadataJson {
  id: string;
  event_id: string;
  name: string;
  order: number;
  color?: string | null;
  capacity?: number | null;
  default_minutes?: number | null;
  created_at: string | null;
  updated_at: string | null;
}

export function iso(value: Date | number | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const ms = value instanceof Date ? value.getTime() : value;
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toISOString();
}

export function serializeMetadata(
  eventId: string,
  row: MetadataInput | null | undefined,
): MetadataJson | null {
  if (!row) return null;
  const json: MetadataJson = {
    id: row.id,
    event_id: eventId,
    name: row.name,
    order: row.order,
    created_at: iso(row.createdAt),
    updated_at: iso(row.updatedAt),
  };
  // Family-specific columns appear only where the family has them, rather than
  // padding every track with a null `capacity`.
  if (row.color !== undefined) json.color = row.color;
  if (row.capacity !== undefined) json.capacity = row.capacity;
  if (row.defaultMinutes !== undefined) json.default_minutes = row.defaultMinutes;
  return json;
}

/* ------------------------------------------------------------- contacts */

export interface ContactInput {
  id: string;
  email: string;
  fullName?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  pronouns?: string | null;
  company?: string | null;
  title?: string | null;
  bio?: string | null;
  headshotKey?: string | null;
  links?: Record<string, string> | null;
  createdAt?: Date | null;
  updatedAt?: Date | null;
}

export interface ContactJson {
  id: string;
  email: string;
  full_name: string | null;
  first_name: string | null;
  last_name: string | null;
  pronouns: string | null;
  company_name: string | null;
  title: string | null;
  /** Sessionboard calls the bio `about`. */
  about: string | null;
  photo_url: string | null;
  links: Record<string, string> | null;
  created_at: string | null;
  updated_at: string | null;
  admin_url: string;
}

/**
 * Speakers are a PROJECTION over contacts, exactly as Sessionboard does it:
 * `POST /v1/event/{id}/speakers` returns `Contact` objects (§3). One shape, so
 * `/speakers` and a future `/contacts` can never drift.
 */
export function serializeContact(
  contact: ContactInput,
  options: { origin: string },
): ContactJson {
  return {
    id: contact.id,
    email: contact.email,
    full_name: contact.fullName ?? null,
    first_name: contact.firstName ?? null,
    last_name: contact.lastName ?? null,
    pronouns: contact.pronouns ?? null,
    company_name: contact.company ?? null,
    title: contact.title ?? null,
    about: contact.bio ?? null,
    // Headshots are proxied through the Worker (DECISIONS #21), so the public
    // handle is the route, never the R2 key.
    photo_url: contact.headshotKey ? `${options.origin}/portal/headshot/${contact.id}` : null,
    links: contact.links ?? null,
    created_at: iso(contact.createdAt),
    updated_at: iso(contact.updatedAt),
    admin_url: `${options.origin}/admin/speakers/${contact.id}`,
  };
}

/* ------------------------------------------------------------- sessions */

export interface ParticipantInput extends ContactInput {
  role: ParticipantRole;
  isPrimary: boolean;
  order: number;
}

export interface ParticipantJson extends ContactJson {
  participant_role: {
    slug: ParticipantRole;
    name: string;
    /** Legacy junction mapping only — never a display label (their docs, §3). */
    core_role: "speaker" | "chairperson" | "moderator";
  };
  is_primary: boolean;
  order: number;
}

const ROLE_LABELS: Record<ParticipantRole, string> = {
  speaker: "Speaker",
  co_speaker: "Co-speaker",
  chairperson: "Chairperson",
  moderator: "Moderator",
  panelist: "Panelist",
};

const ROLE_CORE: Record<ParticipantRole, "speaker" | "chairperson" | "moderator"> = {
  speaker: "speaker",
  co_speaker: "speaker",
  chairperson: "chairperson",
  moderator: "moderator",
  panelist: "speaker",
};

export function serializeParticipant(
  participant: ParticipantInput,
  options: { origin: string },
): ParticipantJson {
  return {
    ...serializeContact(participant, options),
    participant_role: {
      slug: participant.role,
      name: ROLE_LABELS[participant.role],
      core_role: ROLE_CORE[participant.role],
    },
    is_primary: participant.isPrimary,
    order: participant.order,
  };
}

export interface CompositionTargetInput {
  id: string;
  friendlyId: string | null;
  title: string;
  isAbstract: boolean;
}

export interface SessionInput {
  id: string;
  eventId: string;
  friendlyId: string | null;
  title: string;
  description: string | null;
  status: SessionStatus;
  isAbstract: boolean;
  formId: string | null;
  answers: Record<string, unknown> | null;
  videoUrl: string | null;
  externalUrl: string | null;
  startsAt: Date | null;
  endsAt: Date | null;
  capacity: number | null;
  isPublic: boolean;
  publishedAt: Date | null;
  composedIntoSessionId: string | null;
  deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  track: MetadataInput | null;
  room: MetadataInput | null;
  format: MetadataInput | null;
  level: MetadataInput | null;
  participants: ParticipantInput[];
  tags: MetadataInput[];
  /** How many other rows are composed INTO this one. */
  sourceCount: number;
  composedInto: CompositionTargetInput | null;
}

export interface SessionJson {
  id: string;
  event_id: string;
  friendly_id: string | null;
  title: string;
  description: string | null;
  status: SessionStatus;
  is_abstract: boolean;
  form_id: string | null;
  starts_at: string | null;
  ends_at: string | null;
  capacity: number | null;
  is_public: boolean;
  published_at: string | null;
  video_url: string | null;
  external_url: string | null;
  composition_status: {
    role: "standalone" | "source" | "target";
    is_linked: boolean;
    is_read_only: boolean;
    source_count: number;
    target: {
      id: string;
      friendly_id: string | null;
      title: string;
      is_abstract: boolean;
    } | null;
  };
  track: MetadataJson | null;
  room: MetadataJson | null;
  format: MetadataJson | null;
  level: MetadataJson | null;
  tags: MetadataJson[];
  participants: ParticipantJson[];
  custom_fields: { key: string; value: unknown }[];
  created_at: string | null;
  updated_at: string | null;
  deleted_at: string | null;
  admin_url: string;
}

export function serializeSession(
  session: SessionInput,
  options: { origin: string },
): SessionJson {
  const role: "standalone" | "source" | "target" = session.composedIntoSessionId
    ? "source"
    : session.sourceCount > 0
      ? "target"
      : "standalone";

  return {
    id: session.id,
    event_id: session.eventId,
    friendly_id: session.friendlyId,
    title: session.title,
    description: session.description,
    status: session.status,
    is_abstract: session.isAbstract,
    form_id: session.formId,
    starts_at: iso(session.startsAt),
    ends_at: iso(session.endsAt),
    capacity: session.capacity,
    is_public: session.isPublic,
    published_at: iso(session.publishedAt),
    video_url: session.videoUrl,
    external_url: session.externalUrl,
    composition_status: {
      role,
      is_linked: role !== "standalone",
      /*
       * Always false, on purpose. Sessionboard freezes composition SOURCES
       * against every API write and only a human clicking "unlink" in their
       * admin can thaw it (§8.8) — a dead-end with a UI-only escape hatch.
       * We keep the link and keep the record writable.
       */
      is_read_only: false,
      source_count: session.sourceCount,
      target: session.composedInto
        ? {
            id: session.composedInto.id,
            friendly_id: session.composedInto.friendlyId,
            title: session.composedInto.title,
            is_abstract: session.composedInto.isAbstract,
          }
        : null,
    },
    track: serializeMetadata(session.eventId, session.track),
    room: serializeMetadata(session.eventId, session.room),
    format: serializeMetadata(session.eventId, session.format),
    level: serializeMetadata(session.eventId, session.level),
    tags: session.tags
      .map((tag) => serializeMetadata(session.eventId, tag))
      .filter((tag): tag is MetadataJson => tag !== null),
    participants: session.participants.map((participant) =>
      serializeParticipant(participant, options),
    ),
    // CFP answers, keyed by `fields.key`. Sorted so a diff of two responses is
    // stable rather than insertion-ordered.
    //
    // `__`-prefixed keys are dropped. They are the product's own reserved slots
    // inside the same blob — the wizard's `__content` scaffolding, the
    // eligible-track choice, and the on-behalf-of `__capture` provenance —
    // never something a submitter answered, and a registry key can never start
    // with `__` (admin.forms.edit strips leading underscores when it mints
    // one). `admin.submission.tsx` already hides them; an API key widens what
    // you may read, it does not turn internal bookkeeping into a CFP answer.
    custom_fields: Object.entries(session.answers ?? {})
      .filter(([key]) => !key.startsWith("__"))
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, value]) => ({ key, value })),
    created_at: iso(session.createdAt),
    updated_at: iso(session.updatedAt),
    deleted_at: iso(session.deletedAt),
    admin_url: session.isAbstract
      ? `${options.origin}/admin/submissions/${session.id}`
      : `${options.origin}/admin/agenda`,
  };
}

/** The event shape `GET /v1/events` returns. */
export interface EventJson {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  location: string | null;
  timezone: string;
  starts_on: string | null;
  ends_on: string | null;
  created_at: string | null;
  updated_at: string | null;
  admin_url: string;
}

export function serializeEvent(
  event: {
    id: string;
    name: string;
    slug: string;
    description: string | null;
    location: string | null;
    timezone: string;
    startsOn: Date | null;
    endsOn: Date | null;
    createdAt: Date;
    updatedAt: Date;
  },
  options: { origin: string },
): EventJson {
  return {
    id: event.id,
    name: event.name,
    slug: event.slug,
    description: event.description,
    location: event.location,
    timezone: event.timezone,
    starts_on: iso(event.startsOn),
    ends_on: iso(event.endsOn),
    created_at: iso(event.createdAt),
    updated_at: iso(event.updatedAt),
    admin_url: `${options.origin}/admin?event=${encodeURIComponent(event.slug)}`,
  };
}
