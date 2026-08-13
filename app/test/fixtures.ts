/**
 * The UNIT-TEST dataset: a deliberately small, hand-written event (8 abstracts,
 * 2 of them accepted, 2 composed program sessions, 8 tasks half of them
 * complete) that route tests assert EXACT numbers against.
 *
 * ⚠️ This is NOT a mirror of `scripts/seed.mjs`. The demo seed is 30
 * content-driven abstracts across all seven statuses, because the deployed demo
 * has to look like a live event; a unit test asserting `rows).toHaveLength(11)`
 * would be measuring the prose file, not the query. The two share the ids, the
 * shape and the two demo accounts — `app/test/harness.test.ts` guards the parts
 * that must still agree, and guards the seed's own invariants separately.
 */
import { eq } from "drizzle-orm";

import {
  events,
  eventPeople,
  fields,
  formats,
  forms,
  people,
  reviewRounds,
  reviewTeamMembers,
  reviewTeams,
  rooms,
  sessionParticipants,
  sessions,
  taskTemplates,
  tasks,
  tracks,
  type SessionStatus,
} from "~/db/schema";

import type { DB } from "~/db/client.server";

const id = (bucket: string, n: number) =>
  `${String(bucket).padStart(8, "0").slice(0, 8)}-0000-4000-8000-${String(n).padStart(12, "0")}`;

const DAY = 86_400_000;
/** Same fixed clock as scripts/seed.mjs. */
export const FIXTURE_NOW = Date.UTC(2026, 7, 8, 12, 0, 0);
const at = (offsetDays: number, hour = 0) =>
  new Date(FIXTURE_NOW + offsetDays * DAY + hour * 3_600_000);

export const EVENT_ID = id("ev", 1);
export const EVENT_SLUG = "frontier-ai-summit-2026";
export const ADMIN_ID = id("pe", 1);
export const ADMIN_EMAIL = "admin@callboard.dev";
export const CFP_FORM_ID = id("fo", 1);

export const SPEAKERS = [
  { name: "Sam Speaker", email: "speaker@callboard.dev" },
  { name: "Rina Okafor", email: "rina@example.com" },
  { name: "Dev Patel", email: "dev@example.com" },
  { name: "Mira Halvorsen", email: "mira@example.com" },
  { name: "Tomas Berg", email: "tomas@example.com" },
  { name: "Ayesha Khan", email: "ayesha@example.com" },
  { name: "Jonas Weir", email: "jonas@example.com" },
  { name: "Lea Moreau", email: "lea@example.com" },
];


export const TRACK_NAMES = ["Agents", "Evals & Reliability", "Infrastructure"];
export const FORMAT_NAMES = ["Talk", "Workshop", "Lightning"];
export const ROOM_NAMES = ["Main Stage", "Workshop Room 1", "Workshop Room 2"];

/**
 * Registry fields, with the same ids and keys the demo seed uses. The abstract
 * DETAIL page reads answers THROUGH these (label, type, order) — a fixture
 * without them would render an empty answers section and prove nothing.
 * `[key, label, type, constraints, locked]`.
 */
export const FIELD_DEFS = [
  ["title", "Session title", "text", { required: true, maxLength: 120 }, true],
  ["abstract", "Abstract", "wysiwyg", { required: true, minLength: 200 }, true],
  ["track", "Track", "select", { required: true, options: TRACK_NAMES }, false],
  ["format", "Format", "select", { required: true, options: FORMAT_NAMES }, false],
  ["takeaways", "Audience takeaways", "textarea", { required: false, minLength: 80 }, false],
  ["video_url", "Video pitch (optional)", "video_url", { required: false }, false],
  ["prerequisites", "Workshop prerequisites", "textarea", { required: true }, false],
  ["benchmark_url", "Benchmark or eval harness", "url", { required: false }, false],
] as const satisfies readonly [string, string, string, Record<string, unknown>, boolean][];

/** title, status, speaker index — identical to scripts/seed.mjs. */
export const SUBMISSIONS: [string, SessionStatus, number][] = [
  ["Shipping agents that survive contact with users", "accepted", 0],
  ["Evals that actually predict production failures", "accepted", 1],
  ["The retrieval stack nobody benchmarks", "accept_queue", 2],
  ["Cost modelling for multi-agent systems", "pending", 3],
  ["Tool-calling failure modes, catalogued", "pending", 4],
  ["Why your guardrails are theatre", "decline_queue", 5],
  ["A tour of small-model fine-tuning", "declined", 6],
  ["Notes from a year of on-call with LLMs", "withdrawn", 7],
];

export const TASK_TEMPLATES: [string, string, number][] = [
  ["Confirm your slot", "Accept or decline your speaking slot.", 3],
  ["Upload a headshot", "Square, at least 800×800.", 10],
  ["Complete your bio", "150 words, third person.", 10],
  ["Submit your slides", "PDF or PPTX, 16:9.", 45],
];

/** Only the two speakers with a composed programme session get a checklist. */
export const TASK_SPEAKER_INDEXES = [0, 1] as const;

/** Which of a speaker's tasks the seed marks done. Half of them, alternating. */
export const isSeededTaskComplete = (speakerIndex: number, taskIndex: number): boolean =>
  (speakerIndex + taskIndex) % 2 === 0;

/** The company every seeded speaker carries. The admin has none. */
export const seededCompany = (speakerIndex: number): string => `Company ${speakerIndex}`;

/** The fixture's one CFP form. Flip this and the rollup expectations follow. */
export const CFP_FORM_STATUS = "open" as const;

/**
 * WHAT THE SEEDED DATASET ADDS UP TO.
 *
 * Every value is DERIVED from the arrays and rules the inserts below are built
 * from, never written a second time: change `SUBMISSIONS` and the expectation
 * moves with the data, but a rollup query that returns 0, double-counts an
 * accepted abstract and the session composed from it, or fans out across a
 * naive join, moves ONLY the measurement — which is the failure this exists to
 * catch. Both rival entries we reviewed shipped a dashboard whose counts were
 * silently wrong while their list pages stayed correct.
 *
 * Consumed by `app/routes/admin.rollups.test.ts`.
 */
export const FIXTURE_ROLLUPS = {
  /** Abstracts on the primary event. */
  abstracts: SUBMISSIONS.length,
  /**
   * ABSTRACTS with status `accepted` — not every row with that status. The
   * seed composes each accepted abstract into a programme session that carries
   * the same status, so the naive count is double this.
   */
  acceptedAbstracts: SUBMISSIONS.filter(([, status]) => status === "accepted").length,
  /** Rows with status `accepted` of ANY kind: the number the tile must NOT show. */
  acceptedRowsOfAnyKind:
    SUBMISSIONS.filter(([, status]) => status === "accepted").length * 2,
  totalTasks: TASK_SPEAKER_INDEXES.length * TASK_TEMPLATES.length,
  openTasks: TASK_SPEAKER_INDEXES.flatMap((speakerIndex) =>
    TASK_TEMPLATES.map((_, taskIndex) => isSeededTaskComplete(speakerIndex, taskIndex)),
  ).filter((complete) => !complete).length,
  openCfpForms: CFP_FORM_STATUS === "open" ? 1 : 0,
  /** The admin plus every seeded speaker; none are merged away. */
  contacts: SPEAKERS.length + 1,
  events: 1,
  /** One `Company <n>` per speaker, each held by exactly one person. */
  companies: SPEAKERS.length,
  /** A single event, so nobody is on two of them yet. */
  returningContacts: 0,
  /** Programme sessions, published and scheduled. */
  programmeSessions: 2,
} as const;

/* ─────────────────────────────────────────── WS12: the second event ───── */

export const OTHER_EVENT_ID = id("ev", 2);
export const OTHER_EVENT_SLUG = "frontier-ai-summit-europe-2026";
export const OTHER_EVENT_NAME = "Frontier AI Summit Europe 2026";

export interface OtherEventFixture {
  eventId: string;
  slug: string;
  name: string;
  speakerId: string;
  formId: string;
  trackId: string;
  roomId: string;
  abstractIds: string[];
  programSessionId: string;
  teamId: string;
  roundId: string;
  taskId: string;
}

/**
 * A second event, deliberately tiny and with DIFFERENT counts from the primary
 * fixture, so an isolation assertion cannot pass by coincidence: 2 abstracts vs
 * 8, 1 programme session vs 2, 1 task vs 8.
 *
 * ⚠️ `createdAt` is strictly AFTER `FIXTURE_NOW`. `currentEvent()` defaults to
 * the oldest event, so seeding this one earlier would silently make it the
 * default and move every count the route suites assert.
 */
export async function seedOtherEvent(db: DB): Promise<OtherEventFixture> {
  const createdAt = new Date(FIXTURE_NOW + DAY);
  const speakerId = id("pe", 200);
  const formId = id("fo", 20);
  const trackId = id("tr", 20);
  const roomId = id("rm", 20);
  const formatId = id("fm", 20);
  const abstractIds = [id("se", 200), id("se", 201)];
  const programSessionId = id("sp", 20);
  const teamId = id("rt", 20);
  const roundId = id("rr", 20);
  const templateId = id("tt", 20);
  const taskId = id("ta", 200);

  await db.insert(events).values({
    id: OTHER_EVENT_ID,
    name: OTHER_EVENT_NAME,
    slug: OTHER_EVENT_SLUG,
    location: "Amsterdam, NL",
    timezone: "Europe/Amsterdam",
    startsOn: new Date(FIXTURE_NOW + 120 * DAY),
    endsOn: new Date(FIXTURE_NOW + 120 * DAY),
    createdAt,
    updatedAt: createdAt,
  });

  await db.insert(people).values({
    id: speakerId,
    email: "ines.duarte@example.eu",
    fullName: "Ines Duarte",
    role: "speaker",
  });
  await db.insert(eventPeople).values([
    { eventId: OTHER_EVENT_ID, personId: ADMIN_ID, eventRole: "organizer" },
    { eventId: OTHER_EVENT_ID, personId: speakerId, eventRole: "speaker" },
  ]);

  await db
    .insert(rooms)
    .values({ id: roomId, eventId: OTHER_EVENT_ID, name: "Zuiderzaal", capacity: 400, order: 0 });
  await db
    .insert(tracks)
    .values({ id: trackId, eventId: OTHER_EVENT_ID, name: "Production AI", color: "#1971c2", order: 0 });
  await db
    .insert(formats)
    .values({ id: formatId, eventId: OTHER_EVENT_ID, name: "Talk", defaultMinutes: 25, order: 0 });

  await db.insert(forms).values({
    id: formId,
    eventId: OTHER_EVENT_ID,
    name: "Frontier AI Summit Europe CFP",
    target: "submission",
    surface: "cfp",
    status: "open",
  });

  await db.insert(sessions).values([
    {
      id: abstractIds[0],
      eventId: OTHER_EVENT_ID,
      friendlyId: "EU-1",
      title: "Running inference on a European latency budget",
      description: "Europe-only abstract, accepted.",
      status: "accepted",
      isAbstract: true,
      formId,
      trackId,
      formatId,
      createdAt,
      updatedAt: createdAt,
    },
    {
      id: abstractIds[1],
      eventId: OTHER_EVENT_ID,
      friendlyId: "EU-2",
      title: "Retrieval that survives four languages",
      description: "Europe-only abstract, pending.",
      status: "pending",
      isAbstract: true,
      formId,
      trackId,
      formatId,
      createdAt,
      updatedAt: createdAt,
    },
  ]);
  await db.insert(sessionParticipants).values(
    abstractIds.map((sessionId) => ({
      sessionId,
      personId: speakerId,
      role: "speaker" as const,
      isPrimary: true,
      order: 0,
    })),
  );

  await db.insert(sessions).values({
    id: programSessionId,
    eventId: OTHER_EVENT_ID,
    friendlyId: "EU-SESS-1",
    title: "Running inference on a European latency budget",
    status: "accepted",
    isAbstract: false,
    trackId,
    roomId,
    formatId,
    startsAt: new Date(FIXTURE_NOW + 120 * DAY + 10 * 3_600_000),
    endsAt: new Date(FIXTURE_NOW + 120 * DAY + 10 * 3_600_000 + 25 * 60_000),
    isPublic: true,
    publishedAt: createdAt,
  });
  await db.insert(sessionParticipants).values({
    sessionId: programSessionId,
    personId: speakerId,
    role: "speaker",
    isPrimary: true,
    order: 0,
  });
  await db
    .update(sessions)
    .set({ composedIntoSessionId: programSessionId })
    .where(eq(sessions.id, abstractIds[0]));

  await db
    .insert(reviewTeams)
    .values({ id: teamId, eventId: OTHER_EVENT_ID, name: "Europe programme committee" });
  await db.insert(reviewTeamMembers).values({ teamId, personId: ADMIN_ID });
  await db.insert(reviewRounds).values({
    id: roundId,
    eventId: OTHER_EVENT_ID,
    name: "Europe screening",
    ordinal: 1,
  });

  await db.insert(taskTemplates).values({
    id: templateId,
    eventId: OTHER_EVENT_ID,
    title: "Confirm your slot",
    description: "Accept or decline your speaking slot.",
    dueOffsetDays: 3,
    isRequired: true,
    order: 0,
  });
  await db.insert(tasks).values({
    id: taskId,
    eventId: OTHER_EVENT_ID,
    templateId,
    personId: speakerId,
    sessionId: programSessionId,
    title: "Confirm your slot",
    status: "pending",
    dueAt: new Date(FIXTURE_NOW + 3 * DAY),
  });

  return {
    eventId: OTHER_EVENT_ID,
    slug: OTHER_EVENT_SLUG,
    name: OTHER_EVENT_NAME,
    speakerId,
    formId,
    trackId,
    roomId,
    abstractIds,
    programSessionId,
    teamId,
    roundId,
    taskId,
  };
}

export interface DemoFixture {
  eventId: string;
  adminId: string;
  speakerIds: string[];
  trackIds: string[];
  formatIds: string[];
  roomIds: string[];
  abstractIds: string[];
  programSessionIds: string[];
  templateIds: string[];
}

/** Insert the demo dataset. Order respects foreign keys (they are enforced). */
export async function seedDemoFixture(db: DB): Promise<DemoFixture> {
  await db.insert(events).values({
    id: EVENT_ID,
    name: "Frontier AI Summit 2026",
    slug: EVENT_SLUG,
    location: "San Francisco, CA",
    timezone: "America/Los_Angeles",
    startsOn: at(60),
    endsOn: at(62),
    submissionLimit: 3,
    createdAt: new Date(FIXTURE_NOW),
    updatedAt: new Date(FIXTURE_NOW),
  });

  await db.insert(people).values({
    id: ADMIN_ID,
    email: ADMIN_EMAIL,
    fullName: "Ada Organiser",
    role: "admin",
  });
  await db
    .insert(eventPeople)
    .values({ eventId: EVENT_ID, personId: ADMIN_ID, eventRole: "organizer" });

  const speakerIds = SPEAKERS.map((_, index) => id("pe", index + 10));
  await db.insert(people).values(
    SPEAKERS.map((speaker, index) => ({
      id: speakerIds[index],
      email: speaker.email,
      fullName: speaker.name,
      company: seededCompany(index),
      title: index === 0 ? "Demo Speaker" : "Engineer",
      // Speaker 6 is left bio-less ON PURPOSE: the detail page has to render the
      // "no bio yet" state, and a fixture where everyone has one cannot show it.
      bio: index === 6 ? null : `${speaker.name} works on ${speaker.email.split("@")[0]}.`,
      links: index === 0 ? { website: "https://example.com/sam" } : null,
      role: "speaker" as const,
    })),
  );
  await db
    .insert(eventPeople)
    .values(speakerIds.map((personId) => ({ eventId: EVENT_ID, personId })));

  const roomIds = ROOM_NAMES.map((_, index) => id("rm", index + 1));
  await db.insert(rooms).values(
    ROOM_NAMES.map((name, index) => ({
      id: roomIds[index],
      eventId: EVENT_ID,
      name,
      capacity: index === 0 ? 800 : 120,
      order: index,
    })),
  );

  const trackIds = TRACK_NAMES.map((_, index) => id("tr", index + 1));
  await db.insert(tracks).values(
    TRACK_NAMES.map((name, index) => ({
      id: trackIds[index],
      eventId: EVENT_ID,
      name,
      color: ["#329af0", "#f76707", "#37b24d"][index],
      order: index,
    })),
  );

  const formatIds = FORMAT_NAMES.map((_, index) => id("fm", index + 1));
  await db.insert(formats).values(
    FORMAT_NAMES.map((name, index) => ({
      id: formatIds[index],
      eventId: EVENT_ID,
      name,
      defaultMinutes: [30, 90, 10][index],
      order: index,
    })),
  );

  const fieldIds = FIELD_DEFS.map((_, index) => id("fd", index + 1));
  await db.insert(fields).values(
    FIELD_DEFS.map(([key, label, type, constraints, isLocked], index) => ({
      id: fieldIds[index],
      eventId: EVENT_ID,
      module: "session" as const,
      key,
      label,
      type: type as (typeof fields.$inferInsert)["type"],
      constraints,
      isLocked,
      order: index,
    })),
  );

  /** Hydrated ref, matching the shape scripts/seed.mjs writes. */
  const ref = (key: string, order: number) => {
    const index = FIELD_DEFS.findIndex((entry) => entry[0] === key);
    const [, label, type, constraints, locked] = FIELD_DEFS[index];
    const { required, ...validation } = constraints as Record<string, unknown>;
    return {
      fieldId: fieldIds[index],
      key,
      type,
      label,
      scope: "submission",
      order,
      required: Boolean(required),
      ...(locked ? { locked: true } : {}),
      validation: { ...validation, ...(required ? { required: true } : {}) },
    };
  };

  await db.insert(forms).values({
    id: CFP_FORM_ID,
    eventId: EVENT_ID,
    name: "Call for Proposals 2026",
    target: "submission",
    surface: "cfp",
    status: CFP_FORM_STATUS,
    minSpeakers: 1,
    maxSpeakers: 3,
    schema: {
      version: 1,
      fields: [
        ref("title", 0),
        ref("abstract", 1),
        ref("track", 2),
        ref("format", 3),
        ref("prerequisites", 4),
        ref("takeaways", 5),
        ref("benchmark_url", 6),
        ref("video_url", 7),
      ],
      rules: [
        {
          id: "show-prerequisites",
          match: "all",
          when: [{ fieldKey: "format", op: "equals", value: "Workshop" }],
          action: "show",
          targetKeys: ["prerequisites"],
          scope: "submission",
          enabled: true,
        },
      ],
      combinedLimits: [
        {
          id: "programme-block",
          label: "Printed programme block",
          fieldKeys: ["title", "takeaways"],
          maxChars: 300,
          scope: "submission",
          enabled: true,
        },
      ],
      routing: { rules: [], defaultTrackId: trackIds[0] },
      participants: {
        collect: true,
        roles: [{ key: "speaker", label: "Speaker", enabled: true, min: 1, max: 3 }],
        maxTotal: 4,
        minTotal: null,
      },
    },
  });

  const abstractIds = SUBMISSIONS.map((_, index) => id("se", index + 1));
  await db.insert(sessions).values(
    SUBMISSIONS.map(([title, status], index) => ({
      id: abstractIds[index],
      eventId: EVENT_ID,
      friendlyId: `ABS-${index + 1}`,
      title,
      description: `${title}. Seeded abstract body for the demo.`,
      status,
      isAbstract: true,
      formId: CFP_FORM_ID,
      // Flat, keyed by field key — the shape submitDraft() writes.
      answers: {
        title,
        abstract: `${title}. Seeded abstract body for the demo.`,
        track: TRACK_NAMES[index % TRACK_NAMES.length],
        format: FORMAT_NAMES[index % FORMAT_NAMES.length],
        takeaways: "Three concrete things you can apply on Monday morning, with the caveats.",
        ...(FORMAT_NAMES[index % FORMAT_NAMES.length] === "Workshop"
          ? { prerequisites: "A laptop with Python 3.11 and Docker installed." }
          : {}),
        // An answer the form no longer asks for — the detail page must still
        // show it rather than dropping a historical record on the floor.
        ...(index === 0 ? { legacy_note: "Imported from last year's system." } : {}),
      },
      trackId: trackIds[index % trackIds.length],
      formatId: formatIds[index % formatIds.length],
      isPublic: false,
      createdAt: at(-14 + index),
      updatedAt: at(-2),
    })),
  );
  await db.insert(sessionParticipants).values([
    ...SUBMISSIONS.map(([, , speakerIndex], index) => ({
      sessionId: abstractIds[index],
      personId: speakerIds[speakerIndex],
      role: "speaker" as const,
      isPrimary: true,
      order: 0,
    })),
    // One multi-speaker abstract, so "Speakers (2)" and the co-speaker chip are
    // reachable (screenshots p21_1: the Speaker cell holds multiple chips).
    {
      sessionId: abstractIds[0],
      personId: speakerIds[6],
      role: "co_speaker" as const,
      isPrimary: false,
      order: 1,
    },
  ]);

  const programSessionIds = [0, 1].map((index) => id("sp", index + 1));
  await db.insert(sessions).values(
    [0, 1].map((index) => ({
      id: programSessionIds[index],
      eventId: EVENT_ID,
      friendlyId: `SESS-${index + 1}`,
      title: SUBMISSIONS[index][0],
      description: "Program session composed from the accepted abstract.",
      status: "accepted" as const,
      isAbstract: false,
      trackId: trackIds[index % trackIds.length],
      roomId: roomIds[index % roomIds.length],
      formatId: formatIds[0],
      startsAt: at(60, 10 + index),
      endsAt: new Date(at(60, 10 + index).getTime() + 30 * 60_000),
      capacity: 800,
      isPublic: true,
      publishedAt: new Date(FIXTURE_NOW),
    })),
  );
  await db.insert(sessionParticipants).values(
    [0, 1].map((index) => ({
      sessionId: programSessionIds[index],
      personId: speakerIds[index],
      role: "speaker" as const,
      isPrimary: true,
      order: 0,
    })),
  );
  for (const index of [0, 1]) {
    await db
      .update(sessions)
      .set({ composedIntoSessionId: programSessionIds[index] })
      .where(eq(sessions.id, abstractIds[index]));
  }

  const templateIds = TASK_TEMPLATES.map((_, index) => id("tt", index + 1));
  await db.insert(taskTemplates).values(
    TASK_TEMPLATES.map(([title, description, dueOffsetDays], index) => ({
      id: templateIds[index],
      eventId: EVENT_ID,
      title,
      description,
      dueOffsetDays,
      isRequired: true,
      order: index,
    })),
  );

  const taskRows = [];
  for (const speakerIndex of TASK_SPEAKER_INDEXES) {
    for (const [taskIndex, [title, description, offset]] of TASK_TEMPLATES.entries()) {
      const complete = isSeededTaskComplete(speakerIndex, taskIndex);
      taskRows.push({
        id: id("ta", speakerIndex * 10 + taskIndex + 1),
        eventId: EVENT_ID,
        templateId: templateIds[taskIndex],
        personId: speakerIds[speakerIndex],
        sessionId: programSessionIds[speakerIndex],
        title,
        description,
        status: (complete ? "complete" : "pending") as "complete" | "pending",
        dueAt: at(offset),
        completedAt: complete ? at(-1) : null,
      });
    }
  }
  await db.insert(tasks).values(taskRows);

  return {
    eventId: EVENT_ID,
    adminId: ADMIN_ID,
    speakerIds,
    trackIds,
    formatIds,
    roomIds,
    abstractIds,
    programSessionIds,
    templateIds,
  };
}
