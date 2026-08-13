/**
 * Program > Abstracts > one abstract (`/admin/submissions/:id`).
 *
 * The review flow's missing middle. The table (screenshots p18_1) is a decision
 * surface with no room for the thing being decided: an admin could set a status
 * but never READ the abstract. This is that page — full text, the speakers and
 * their bios, the answers to whatever custom questions the form asked, and the
 * same status popover the table has (literally the same component), plus
 * prev/next so a reviewer can walk a tab end to end without going back to the
 * list between rows.
 *
 * ── Query budget ────────────────────────────────────────────────────────────
 * EIGHT statements in TWO waves, and the count does not move with the number of
 * speakers or answers — that is the no-N+1 property, and
 * `admin.submission.test.tsx` asserts it by counting prepared statements while
 * adding participants to the row.
 *   wave 1 (concurrent): row+joins · participants+people · the field registry
 *   wave 2: the sibling id list for prev/next, which needs the tab, which
 *           defaults to the row's own status and so cannot be known until
 *           wave 1 has answered.
 *
 * ⚠️ Wave 1 is `Promise.all`, NOT `db.batch`, and that is load-bearing.
 * Drizzle emits joined selects with NO column aliases — this query returns
 * `name` three times (tracks, formats, levels, rooms, forms) and `id` twice.
 * Its normal path reads D1's POSITIONAL `raw()` output, so that is fine. But
 * `db.batch()` returns object rows and drizzle maps them with `Object.values()`,
 * where duplicate keys collapse and silently shift every column after them —
 * here it fed `forms.schema` a value from the wrong column. Batch only selects
 * whose result-column names are unique.
 *
 * Router-free markup, like the table: plain `<a>`, plain `<form method="post">`,
 * `<details>` for the popover. The default export renders under
 * `renderToStaticMarkup` with no router context, which is what makes the render
 * tests real page renders instead of assertions about loader data.
 */
import { and, asc, desc, eq, isNull } from "drizzle-orm";
import type { ReactNode } from "react";
import { data, redirect } from "react-router";

import { AiTriageCard, type AiTriageCardData } from "~/components/ai-triage-card";
import { StatusCell, StatusPill } from "~/components/admin-status";
import {
  RevisionHistory,
  toRevisionEntries,
  type RevisionEntry,
} from "~/components/revision-history";
import { eyebrowClass, LaneStub, linkClass } from "~/components/shell";
import { chunkForBind, getDb } from "~/db/client.server";
import {
  fields as fieldsTable,
  eventPeople,
  formats,
  forms,
  levels,
  PARTICIPANT_ROLES,
  people,
  reviewAssignments,
  reviewRounds,
  reviews,
  reviewTeamMembers,
  reviewTeams,
  rooms,
  sessionParticipants,
  sessions,
  tracks,
  type SessionStatus,
} from "~/db/schema";
import { updateSessionContent } from "~/lib/admin/session-edit.server";
import {
  addSessionParticipant,
  PARTICIPANT_ROLE_LABELS,
  removeSessionParticipant,
} from "~/lib/admin/session-participants.server";
import {
  listSessionRevisions,
  restoreSessionRevision,
} from "~/lib/admin/session-revisions.server";
import { requireAdmin } from "~/lib/auth/auth.server";
import {
  CAPTURE_SOURCE_LABELS,
  captureProvenance,
  type CaptureProvenance,
} from "~/lib/capture";
import { appUrl } from "~/lib/env.server";
import { currentEvent } from "~/lib/event.server";
import {
  hydrateFieldRefs,
  parseFormSchema,
  textOf,
  type FieldType,
} from "~/lib/form-schema";
import {
  FORMAT_ANSWER_KEYS,
  LEVEL_ANSWER_KEYS,
  readNamedOptionAnswer,
} from "~/lib/public-submit/normalize";
import {
  currentRoundCriteria,
  dismissTriage,
  loadTriage,
  parseOrganizerScore,
  saveOrganizerScore,
  triageBinding,
  triageSubmission,
} from "~/lib/review/ai-triage.server";
import { applyAbstractStatus } from "~/lib/review/commit.server";
import {
  aggregateFor,
  choiceSummaries,
  rubricMaxTotal,
  weightedAggregateFor,
  type ChoiceSummary,
} from "~/lib/review/aggregate";
import { isAdminAssignable, parseTab, statusLabel, tabFor } from "~/lib/review/pipeline";
import { socialHref } from "~/lib/social-href";
import {
  DEFAULT_RUBRIC,
  isSelectCriterion,
  isTextCriterion,
  isUnscoredCriterion,
  parseRubric,
  scoreRubric,
  type Rubric,
} from "~/lib/review/scoring";
import type { Route } from "./+types/admin.submission";

export function meta({ loaderData }: Route.MetaArgs) {
  const title = loaderData?.detail?.title;
  return [{ title: title ? `${title} — callboard admin` : "Abstract — callboard admin" }];
}

/* ------------------------------------------------------------- shaping */

export interface DetailSpeaker {
  personId: string;
  name: string;
  email: string;
  role: string;
  isPrimary: boolean;
  company: string | null;
  title: string | null;
  bio: string | null;
  /** [label, href] pairs from `people.links`. */
  links: [string, string][];
}

export interface CandidateRow {
  personId: string;
  name: string;
  email: string;
}

/** One custom question and the answer this submission gave it. */
export interface DetailAnswer {
  key: string;
  label: string;
  type: FieldType | "unknown";
  /** Already flattened to text — wysiwyg markup is stripped, arrays joined. */
  value: string;
  /** True when the answer key is not on the form's schema (a legacy answer). */
  offSchema: boolean;
}

export interface SubmissionDetail {
  id: string;
  friendlyId: string | null;
  title: string;
  status: SessionStatus;
  /** Full abstract text: the `abstract` answer, else `sessions.description`. */
  abstract: string;
  trackName: string | null;
  trackColor: string | null;
  formatName: string | null;
  levelName: string | null;
  roomName: string | null;
  formId: string | null;
  formName: string;
  videoUrl: string | null;
  externalUrl: string | null;
  composedIntoSessionId: string | null;
  submittedAt: string | null;
  updatedAt: string | null;
}

export interface SiblingLink {
  id: string;
  friendlyId: string | null;
  title: string;
}

export interface ReviewRoundView {
  id: string;
  name: string;
  ordinal: number;
  rubric: Rubric;
  review: {
    scores: Record<string, number | string>;
    totalScore: number;
    comment: string;
    submittedAt: string | null;
  } | null;
  assignedTeams: string[];
  canReview: boolean;
  aggregate: { reviewerCount: number; averageScore: number | null } | null;
  choices: ChoiceSummary[];
  /**
   * Every SUBMITTED review in this round, including other reviewers'. The
   * organizer is the audience for reviewer comments; the reviewer's own
   * workspace is where they are private FROM other reviewers, not from the
   * organizer. Never widened to a public or speaker-facing loader.
   */
  submittedReviews: {
    reviewerId: string;
    reviewerName: string;
    scores: Record<string, number | string>;
    totalScore: number;
    comment: string;
    submittedAt: string;
  }[];
}

/** Keys rendered by the page's own chrome rather than the answers list. */
const CHROME_KEYS = new Set(["title", "abstract"]);

const ABSTRACT_KEYS = ["abstract", "description", "body"];

/**
 * The abstract's prose from a raw `sessions.answers` blob, for callers that do
 * not have the field registry loaded (the action, which is a write path and
 * has no business issuing the loader's five reads to build a prompt).
 *
 * Reads the draft shape (`{ fields: {...} }`) as well as the flat submitted
 * shape, and strips wysiwyg markup: sending `<p>` tags to a model wastes the
 * prompt budget on nothing.
 */
export function abstractTextOf(
  answers: Record<string, unknown> | null | undefined,
  description: string | null,
): string {
  const raw = (answers ?? {}) as Record<string, unknown>;
  const bag = (
    raw.fields && typeof raw.fields === "object" ? (raw.fields as Record<string, unknown>) : raw
  ) as Record<string, unknown>;
  const found = ABSTRACT_KEYS.map((key) => textOf(bag[key] as never, "wysiwyg").trim()).find(
    Boolean,
  );
  return found ?? description ?? "";
}

const participantRoles = PARTICIPANT_ROLES.map((value) => ({
  value,
  label: PARTICIPANT_ROLE_LABELS[value],
}));

function listUrl(tab: SessionStatus, trackId: string | null): string {
  const params = new URLSearchParams({ tab });
  if (trackId) params.set("track", trackId);
  return `/admin/submissions?${params.toString()}`;
}

export function detailUrl(id: string, tab: SessionStatus, trackId: string | null): string {
  const params = new URLSearchParams({ tab });
  if (trackId) params.set("track", trackId);
  return `/admin/submissions/${id}?${params.toString()}`;
}

/**
 * Only same-origin paths are honoured as a return target. `returnTo` arrives in
 * a form body, so an absolute URL here would be an open redirect signed by the
 * admin's own session.
 */
export function safeReturnTo(value: unknown, fallback: string): string {
  const raw = String(value ?? "");
  return raw.startsWith("/") && !raw.startsWith("//") ? raw : fallback;
}

/* -------------------------------------------------------------- loader */

export async function loader({ request, params }: Route.LoaderArgs) {
  const admin = await requireAdmin(request);
  const event = await currentEvent(request);
  const url = new URL(request.url);
  const trackId = url.searchParams.get("track") || null;
  const requestedTab = url.searchParams.get("tab");

  const notFound = {
    event: null,
    detail: null as SubmissionDetail | null,
    speakers: [] as DetailSpeaker[],
    candidates: [] as CandidateRow[],
    roles: participantRoles,
    answers: [] as DetailAnswer[],
    capture: null as CaptureProvenance | null,
    tab: parseTab(requestedTab),
    trackId,
    prev: null as SiblingLink | null,
    next: null as SiblingLink | null,
    position: null as { index: number; total: number } | null,
    rounds: [] as ReviewRoundView[],
    triage: null as AiTriageCardData | null,
    aiAvailable: triageBinding() !== null,
    revisions: [] as RevisionEntry[],
  };
  if (!event) return notFound;

  const db = getDb();

  /* ── wave 1: the row, its people, and the field registry ────────────── */
  const [
    rowResult,
    participantResult,
    rosterResult,
    registryResult,
    roundReviewResult,
    assignmentResult,
    triageResult,
    revisionRows,
  ] = await Promise.all([
    db
      .select({
        session: sessions,
        trackName: tracks.name,
        trackColor: tracks.color,
        formatName: formats.name,
        levelName: levels.name,
        roomName: rooms.name,
        formId: forms.id,
        formName: forms.name,
        formSchema: forms.schema,
      })
      .from(sessions)
      .leftJoin(tracks, eq(tracks.id, sessions.trackId))
      .leftJoin(formats, eq(formats.id, sessions.formatId))
      .leftJoin(levels, eq(levels.id, sessions.levelId))
      .leftJoin(rooms, eq(rooms.id, sessions.roomId))
      .leftJoin(forms, eq(forms.id, sessions.formId))
      .where(
        and(
          eq(sessions.id, params.id),
          eq(sessions.eventId, event.id),
          eq(sessions.isAbstract, true),
          isNull(sessions.deletedAt),
        ),
      ),
    db
      .select({
        personId: people.id,
        name: people.fullName,
        email: people.email,
        company: people.company,
        personTitle: people.title,
        bio: people.bio,
        links: people.links,
        role: sessionParticipants.role,
        isPrimary: sessionParticipants.isPrimary,
        order: sessionParticipants.order,
      })
      .from(sessionParticipants)
      .innerJoin(people, eq(people.id, sessionParticipants.personId))
      .where(eq(sessionParticipants.sessionId, params.id))
      .orderBy(asc(sessionParticipants.order)),
    db
      .select({ personId: people.id, name: people.fullName, email: people.email })
      .from(eventPeople)
      .innerJoin(people, eq(people.id, eventPeople.personId))
      .where(eq(eventPeople.eventId, event.id))
      .orderBy(asc(people.fullName)),
    db
      .select({
        id: fieldsTable.id,
        key: fieldsTable.key,
        label: fieldsTable.label,
        type: fieldsTable.type,
        helpText: fieldsTable.helpText,
        constraints: fieldsTable.constraints,
        isLocked: fieldsTable.isLocked,
      })
      .from(fieldsTable)
      .where(and(eq(fieldsTable.eventId, event.id), isNull(fieldsTable.archivedAt)))
      .orderBy(asc(fieldsTable.order)),
    db
      .select({
        round: reviewRounds,
        review: reviews,
        reviewerName: people.fullName,
        reviewerEmail: people.email,
      })
      .from(reviewRounds)
      .leftJoin(
        reviews,
        and(
          eq(reviews.roundId, reviewRounds.id),
          eq(reviews.sessionId, params.id),
        ),
      )
      .leftJoin(people, eq(people.id, reviews.reviewerId))
      .where(eq(reviewRounds.eventId, event.id))
      .orderBy(asc(reviewRounds.ordinal)),
    db
      .select({
        roundId: reviewAssignments.roundId,
        teamId: reviewAssignments.teamId,
        teamName: reviewTeams.name,
        reviewerId: reviewTeamMembers.personId,
      })
      .from(reviewAssignments)
      .innerJoin(reviewTeams, eq(reviewTeams.id, reviewAssignments.teamId))
      .leftJoin(
        reviewTeamMembers,
        and(
          eq(reviewTeamMembers.teamId, reviewAssignments.teamId),
          eq(reviewTeamMembers.personId, admin.id),
        ),
      )
      .where(eq(reviewAssignments.sessionId, params.id)),
    // One more statement in wave 1, and a constant one: the AI first pass is
    // one row per submission, so this cannot become an N+1 however many
    // speakers or rounds the abstract grows.
    loadTriage(db, { eventId: event.id, sessionId: params.id }),
    listSessionRevisions(params.id, event.id),
  ]);

  const found = rowResult[0];
  // No current event is a valid empty state, but an id absent from that event
  // is a missing resource; `data()` preserves the route's friendly body.
  if (!found) return data(notFound, { status: 404 });
  const roundResult = Array.from(
    new Map(roundReviewResult.map((entry) => [entry.round.id, entry.round])).values(),
  );
  const reviewResult = roundReviewResult.flatMap((entry) =>
    entry.review
      ? [{ ...entry.review, reviewerName: entry.reviewerName, reviewerEmail: entry.reviewerEmail }]
      : [],
  );
  const row = found.session;

  const rawAnswers = (row.answers ?? {}) as Record<string, unknown>;
  // A DRAFT stores the wizard's scaffolding ({ fields, participants, __content });
  // a submitted row stores the answers flat. Read whichever this is.
  const answerBag = (
    rawAnswers.fields && typeof rawAnswers.fields === "object"
      ? (rawAnswers.fields as Record<string, unknown>)
      : rawAnswers
  ) as Record<string, unknown>;

  const refs = hydrateFieldRefs(parseFormSchema(found.formSchema).fields, registryResult);
  const labelled = new Map(refs.map((ref) => [ref.key, ref]));

  const answers: DetailAnswer[] = [];
  for (const ref of refs) {
    if (CHROME_KEYS.has(ref.key)) continue;
    const value = textOf(answerBag[ref.key] as never, ref.type).trim();
    if (!value) continue;
    answers.push({ key: ref.key, label: ref.label, type: ref.type, value, offSchema: false });
  }
  // Answers the form no longer asks for still belong on the page — the admin is
  // reading a historical record, not re-rendering the form.
  for (const [key, value] of Object.entries(answerBag)) {
    if (CHROME_KEYS.has(key) || labelled.has(key) || key.startsWith("__")) continue;
    const text = textOf(value as never).trim();
    if (!text) continue;
    answers.push({ key, label: key, type: "unknown", value: text, offSchema: true });
  }

  const abstract =
    ABSTRACT_KEYS.map((key) => textOf(answerBag[key] as never, labelled.get(key)?.type))
      .map((value) => value.trim())
      .find(Boolean) ??
    row.description ??
    "";

  const detail: SubmissionDetail = {
    id: row.id,
    friendlyId: row.friendlyId,
    title: row.title,
    status: row.status,
    abstract,
    trackName: found.trackName,
    trackColor: found.trackColor,
    formatName:
      found.formatName ?? readNamedOptionAnswer(answerBag, FORMAT_ANSWER_KEYS),
    levelName: found.levelName ?? readNamedOptionAnswer(answerBag, LEVEL_ANSWER_KEYS),
    roomName: found.roomName,
    formId: found.formId,
    formName: found.formName ?? "Manual",
    videoUrl: row.videoUrl,
    externalUrl: row.externalUrl,
    composedIntoSessionId: row.composedIntoSessionId,
    submittedAt: row.createdAt ? new Date(row.createdAt).toISOString() : null,
    updatedAt: row.updatedAt ? new Date(row.updatedAt).toISOString() : null,
  };

  const speakers: DetailSpeaker[] = participantResult.map((entry) => ({
    personId: entry.personId,
    name: entry.name ?? entry.email,
    email: entry.email,
    role: entry.role,
    isPrimary: entry.isPrimary,
    company: entry.company,
    title: entry.personTitle,
    bio: entry.bio,
    links: Object.entries((entry.links ?? {}) as Record<string, string>).filter(
      ([, href]) => typeof href === "string" && href.trim().length > 0,
    ),
  }));
  const speakerIds = new Set(speakers.map((speaker) => speaker.personId));
  const candidates: CandidateRow[] = rosterResult
    .filter((entry) => !speakerIds.has(entry.personId))
    .map((entry) => ({
      personId: entry.personId,
      name: entry.name ?? entry.email,
      email: entry.email,
    }));

  /* ── wave 2: prev/next within the tab the reviewer is walking ───────── */
  // Defaults to the row's OWN status so a bare /admin/submissions/:id still
  // navigates instead of landing in an unrelated tab.
  const tab = requestedTab ? parseTab(requestedTab) : row.status;
  const siblingScope = [
    eq(sessions.eventId, event.id),
    eq(sessions.isAbstract, true),
    isNull(sessions.deletedAt),
    eq(sessions.status, tab),
  ];
  const siblings = await db
    .select({ id: sessions.id, friendlyId: sessions.friendlyId, title: sessions.title })
    .from(sessions)
    .where(and(...siblingScope, ...(trackId ? [eq(sessions.trackId, trackId)] : [])))
    // Same ordering as the table, or "next" would not be the next row on screen.
    .orderBy(desc(sessions.createdAt));

  const index = siblings.findIndex((entry) => entry.id === row.id);

  return {
    event: { id: event.id, name: event.name, slug: event.slug },
    detail,
    speakers,
    candidates,
    roles: participantRoles,
    answers,
    triage: triageResult,
    /*
     * Read from the BINDING, not from a var an operator could set to "true" on
     * a Worker that has no Workers AI. A card that offers a button which
     * cannot work is worse than one that admits it cannot.
     */
    aiAvailable: triageBinding() !== null,
    // Read off the RAW blob, not `answerBag`: a captured row stores provenance
    // at the top level, and a draft's `fields` sub-object would hide it.
    capture: captureProvenance(rawAnswers),
    tab,
    trackId,
    prev: index > 0 ? siblings[index - 1] : null,
    next: index >= 0 && index < siblings.length - 1 ? siblings[index + 1] : null,
    position: index >= 0 ? { index: index + 1, total: siblings.length } : null,
    revisions: toRevisionEntries(revisionRows),
    rounds: roundResult.map((round): ReviewRoundView => {
      const saved = reviewResult.find(
        (review) => review.roundId === round.id && review.reviewerId === admin.id,
      );
      const assigned = assignmentResult.filter((assignment) => assignment.roundId === round.id);
      const submitted = reviewResult.filter(
        (review) => review.roundId === round.id && review.submittedAt,
      );
      const parsedRubric = parseRubric(round.rubric);
      return {
        id: round.id,
        name: round.name,
        ordinal: round.ordinal,
        rubric: parsedRubric,
        review: saved
          ? {
              scores: saved.scores ?? {},
              totalScore: saved.totalScore ?? 0,
              comment: saved.comment ?? "",
              submittedAt: saved.submittedAt ? new Date(saved.submittedAt).toISOString() : null,
            }
          : null,
        assignedTeams: assigned.map((assignment) => assignment.teamName),
        canReview: assigned.some((assignment) => assignment.reviewerId === admin.id),
        /*
         * COUNTED reviews, not merely submitted ones.
         *
         * This average used to be an inline reduce over every submitted row,
         * which meant it included recusals — so a submission with one genuine
         * review of 10 and one recused reviewer's 15 read "2 submitted ·
         * average 12.5 / 15" here while the submissions list, the CSV and the
         * score export all said one review of 10. Both numbers were defensible
         * on their own and neither said which population it covered, which is
         * the same defect as ABS-10 one level down.
         *
         * `weightedAggregateFor` is the list's own function, so the two screens
         * cannot drift again without a test in aggregate.test.ts going red.
         * `choiceSummaries` on the next line has always excluded recusals; this
         * aggregate was the odd one out in its own object literal.
         */
        aggregate: (() => {
          const rubricByRound = new Map([[round.id, parsedRubric]]);
          const weighted = weightedAggregateFor(submitted, rubricByRound);
          const counted = aggregateFor(submitted, rubricByRound).reviewCount;
          return counted === 0
            ? null
            : { reviewerCount: counted, averageScore: weighted.average };
        })(),
        choices: choiceSummaries(parsedRubric, submitted),
        submittedReviews: submitted.map((review) => ({
          reviewerId: review.reviewerId,
          reviewerName: review.reviewerName ?? review.reviewerEmail ?? "Unknown reviewer",
          scores: review.scores ?? {},
          totalScore: review.totalScore ?? 0,
          comment: review.comment ?? "",
          submittedAt: new Date(review.submittedAt!).toISOString(),
        })).sort((a, b) => a.submittedAt.localeCompare(b.submittedAt)),
      };
    }),
  };
}

/* -------------------------------------------------------------- action */

export async function action({ request, params }: Route.ActionArgs) {
  const admin = await requireAdmin(request);
  const event = await currentEvent(request);
  if (!event) return { ok: false as const, error: "No event exists yet. Create one in Settings first." };

  const db = getDb();
  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "");
  const tab = parseTab(String(formData.get("tab") ?? ""));
  const trackFilter = String(formData.get("track") ?? "").trim() || null;

  if (intent === "create-review-round") {
    const target = await db.query.sessions.findFirst({
      where: and(
        eq(sessions.id, params.id),
        eq(sessions.eventId, event.id),
        eq(sessions.isAbstract, true),
      ),
    });
    if (!target) return { ok: false as const, error: "That abstract no longer exists." };

    const existing = await db
      .select()
      .from(reviewRounds)
      .where(eq(reviewRounds.eventId, event.id))
      .orderBy(asc(reviewRounds.ordinal));
    const previous = existing.at(-1);
    const ordinal = (previous?.ordinal ?? 0) + 1;
    const requestedName = String(formData.get("name") ?? "").trim();
    const roundId = crypto.randomUUID();
    const previousAssignments = previous
      ? await db
          .select()
          .from(reviewAssignments)
          .where(eq(reviewAssignments.roundId, previous.id))
      : [];
    await db.insert(reviewRounds).values({
      id: roundId,
      eventId: event.id,
      name: requestedName || `Round ${ordinal}`,
      ordinal,
      rubric: previous?.rubric ?? { criteria: DEFAULT_RUBRIC.criteria },
      opensAt: new Date(),
    });
    const clonedAssignments = previousAssignments.map((assignment) => ({
      id: crypto.randomUUID(),
      roundId,
      sessionId: assignment.sessionId,
      teamId: assignment.teamId,
    }));
    for (const chunk of chunkForBind(clonedAssignments, 4)) {
      await db.insert(reviewAssignments).values(chunk);
    }
    return redirect(detailUrl(params.id, tab, trackFilter));
  }

  /*
   * ── AI triage ────────────────────────────────────────────────────────────
   * Both intents sit BELOW `requireAdmin` at the top of this action, so a
   * speaker or an anonymous POST is rejected before either one is reached
   * (403 / login redirect respectively) — see admin.submission.aitriage.test.
   * Neither ever touches `sessions.status`.
   */
  if (intent === "run-ai-triage" || intent === "dismiss-ai-triage") {
    const target = await db.query.sessions.findFirst({
      where: and(
        eq(sessions.id, params.id),
        eq(sessions.eventId, event.id),
        eq(sessions.isAbstract, true),
        isNull(sessions.deletedAt),
      ),
    });
    if (!target) return { ok: false as const, error: "That abstract no longer exists." };

    const ai = triageBinding();
    if (!ai) {
      return {
        ok: false as const,
        error: "AI triage unavailable in this deployment — no Workers AI binding is configured.",
      };
    }

    if (intent === "dismiss-ai-triage") {
      const { ok: dismissed } = await dismissTriage(db, { eventId: event.id, sessionId: params.id });
      if (!dismissed) {
        return {
          ok: false as const,
          error:
            "This AI triage opinion is still being generated by a bulk run — try dismissing it again in a moment.",
        };
      }
      return redirect(detailUrl(params.id, tab, trackFilter));
    }

    const track = target.trackId
      ? await db.query.tracks.findFirst({ where: eq(tracks.id, target.trackId) })
      : null;
    const format = target.formatId
      ? await db.query.formats.findFirst({ where: eq(formats.id, target.formatId) })
      : null;

    await triageSubmission(db, {
      eventId: event.id,
      sessionId: params.id,
      requestedById: admin.id,
      ai,
      criteria: await currentRoundCriteria(db, event.id),
      submission: {
        title: target.title,
        abstract: abstractTextOf(target.answers, target.description),
        trackName: track?.name ?? null,
        formatName: format?.name ?? null,
      },
    });
    return redirect(detailUrl(params.id, tab, trackFilter));
  }

  if (intent === "save-organizer-score") {
    const target = await db.query.sessions.findFirst({
      where: and(
        eq(sessions.id, params.id),
        eq(sessions.eventId, event.id),
        eq(sessions.isAbstract, true),
        isNull(sessions.deletedAt),
      ),
    });
    if (!target) return { ok: false as const, error: "That abstract no longer exists." };

    const rawScore = formData.get("organizerScore");
    const score = parseOrganizerScore(typeof rawScore === "string" ? rawScore : null);
    if (score === null) {
      return { ok: false as const, error: "Your score must be a number from 1 to 5." };
    }
    const rawNote = formData.get("organizerNote");
    const result = await saveOrganizerScore(db, {
      eventId: event.id,
      sessionId: params.id,
      scoredById: admin.id,
      score,
      note: typeof rawNote === "string" ? rawNote : null,
    });
    if (!result.ok) return result;
    return redirect(detailUrl(params.id, tab, trackFilter));
  }

  if (intent === "save-review") {
    const target = await db.query.sessions.findFirst({
      where: and(
        eq(sessions.id, params.id),
        eq(sessions.eventId, event.id),
        eq(sessions.isAbstract, true),
      ),
    });
    if (!target) return { ok: false as const, error: "That abstract no longer exists." };

    const roundId = String(formData.get("roundId") ?? "");
    const round = await db.query.reviewRounds.findFirst({
      where: and(eq(reviewRounds.id, roundId), eq(reviewRounds.eventId, event.id)),
    });
    if (!round) return { ok: false as const, error: "That review round no longer exists." };

    const assignment = await db
      .select({ id: reviewAssignments.id })
      .from(reviewAssignments)
      .innerJoin(
        reviewTeamMembers,
        eq(reviewTeamMembers.teamId, reviewAssignments.teamId),
      )
      .where(
        and(
          eq(reviewAssignments.roundId, roundId),
          eq(reviewAssignments.sessionId, params.id),
          eq(reviewTeamMembers.personId, admin.id),
        ),
      )
      .limit(1);
    if (assignment.length === 0) {
      return {
        ok: false as const,
        error: "You are not assigned to review this submission in this round.",
      };
    }

    const rubric = parseRubric(round.rubric);
    const submitted = Object.fromEntries(
      rubric.criteria.map((criterion) => [
        criterion.key,
        formData.get(`score-${criterion.key}`),
      ]),
    );
    const scored = scoreRubric(rubric, submitted);
    if (!scored.ok) return { ok: false as const, error: scored.error };

    const now = new Date();
    const comment = String(formData.get("comment") ?? "").trim() || null;
    await db
      .insert(reviews)
      .values({
        id: crypto.randomUUID(),
        roundId,
        sessionId: params.id,
        reviewerId: admin.id,
        scores: scored.scores,
        totalScore: scored.totalScore,
        comment,
        submittedAt: now,
      })
      .onConflictDoUpdate({
        target: [reviews.roundId, reviews.sessionId, reviews.reviewerId],
        set: { scores: scored.scores, totalScore: scored.totalScore, comment, submittedAt: now, updatedAt: now },
    });
    return redirect(detailUrl(params.id, tab, trackFilter));
  }

  if (intent === "restore-revision") {
    const result = await restoreSessionRevision({
      revisionId: String(formData.get("revisionId") ?? ""),
      sessionId: params.id,
      eventId: event.id,
      editor: {
        personId: admin.id,
        name: admin.fullName ?? admin.email,
      },
    });
    if (!result.ok) return { ok: false as const, error: result.error };
    return redirect(detailUrl(params.id, tab, trackFilter));
  }

  if (intent === "edit-abstract") {
    const target = await db.query.sessions.findFirst({
      where: and(
        eq(sessions.id, params.id),
        eq(sessions.eventId, event.id),
        eq(sessions.isAbstract, true),
      ),
    });
    if (!target) return { ok: false as const, error: "That abstract no longer exists." };

    // This writes title/description on the abstract AND, when the abstract has
    // been accepted and composed, on its programme session — the row the public
    // schedule reads. It writes nothing else; placement and decision state stay
    // on their own paths.
    const result = await updateSessionContent({
      sessionId: params.id,
      eventId: event.id,
      title: String(formData.get("title") ?? ""),
      abstract: String(formData.get("abstract") ?? ""),
      editor: {
        personId: admin.id,
        name: admin.fullName ?? admin.email,
        source: "admin_edit",
      },
    });
    if (!result.ok) return { ok: false as const, error: result.error };
    return redirect(detailUrl(params.id, tab, trackFilter));
  }

  if (intent === "add-participant") {
    const target = await db.query.sessions.findFirst({
      where: and(
        eq(sessions.id, params.id),
        eq(sessions.eventId, event.id),
        eq(sessions.isAbstract, true),
      ),
    });
    if (!target) return { ok: false as const, error: "That abstract no longer exists." };

    const result = await addSessionParticipant({
      sessionId: params.id,
      eventId: event.id,
      personId: String(formData.get("personId") ?? ""),
      role: String(formData.get("role") ?? ""),
    });
    if (!result.ok) return { ok: false as const, error: result.error };
    return redirect(detailUrl(params.id, tab, trackFilter));
  }

  if (intent === "remove-participant") {
    const target = await db.query.sessions.findFirst({
      where: and(
        eq(sessions.id, params.id),
        eq(sessions.eventId, event.id),
        eq(sessions.isAbstract, true),
      ),
    });
    if (!target) return { ok: false as const, error: "That abstract no longer exists." };

    const result = await removeSessionParticipant({
      sessionId: params.id,
      eventId: event.id,
      personId: String(formData.get("personId") ?? ""),
    });
    if (!result.ok) return { ok: false as const, error: result.error };
    return redirect(detailUrl(params.id, tab, trackFilter));
  }

  if (intent !== "set-status") {
    return { ok: false as const, error: `Unknown intent "${intent}".` };
  }

  const status = String(formData.get("status") ?? "");
  if (!isAdminAssignable(status)) {
    return { ok: false as const, error: `"${status}" is not an admin-assignable status.` };
  }

  // Scoped exactly like the table's action: this event, this abstract. The id in
  // the body must match the id in the path, so a POST cannot restatus a row the
  // admin is not looking at.
  const sessionId = String(formData.get("sessionId") ?? "");
  if (sessionId !== params.id) {
    return { ok: false as const, error: "That abstract no longer exists." };
  }

  const target = await db.query.sessions.findFirst({
    where: and(
      eq(sessions.id, sessionId),
      eq(sessions.eventId, event.id),
      eq(sessions.isAbstract, true),
    ),
  });
  if (!target) return { ok: false as const, error: "That abstract no longer exists." };

  // `origin` matters: `notifyDecisions` suppresses the whole run rather than
  // mail a portal link it cannot build, so omitting it here would turn the
  // radio into a silent non-sender.
  await applyAbstractStatus({
    eventId: event.id,
    abstractId: sessionId,
    status,
    origin: appUrl(request),
    db,
  });

  return redirect(
    safeReturnTo(formData.get("returnTo"), detailUrl(sessionId, tab, trackFilter)),
  );
}

/* ------------------------------------------------------------------ UI */

const CARD = "rounded-lg border border-gray-200 p-4 dark:border-gray-800";
const GHOST_BUTTON = "rounded border border-gray-300 px-3 py-1.5 text-sm dark:border-gray-700";
const FIELD =
  "rounded border border-gray-300 px-2 py-1 text-sm dark:border-gray-700 dark:bg-gray-900";

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toISOString().slice(0, 10);
}

function Meta({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt className={eyebrowClass}>{label}</dt>
      <dd className="mt-0.5 text-sm">{children}</dd>
    </div>
  );
}

/**
 * Strip React Router's `data()` wrapper back off a loader return type.
 *
 * Returning `data(notFound, { status: 404 })` from ONE branch widens the whole
 * loader to `Payload | DataWithResponseInit<Payload>`. Everything derived from
 * `ReturnType<typeof loader>` then sees a union whose two arms share no
 * properties, so `.detail` stops existing — which broke this component's props
 * and three unrelated test files that had nothing to do with the status code.
 *
 * `T` is naked here, so the conditional DISTRIBUTES over that union and maps
 * both arms back to the payload. Attaching a status stays a runtime concern
 * instead of leaking into every consumer's types.
 *
 * Matched structurally because react-router only exports the class as
 * `UNSAFE_DataWithResponseInit`, and its `type` field is declared `string`
 * rather than a literal, so there is no discriminant to key on. The payload has
 * no `data`/`init` pair of its own, which is what makes this unambiguous.
 */
type UnwrapData<T> = T extends { type: string; data: infer P; init: ResponseInit | null }
  ? P
  : T;

/** The loader's payload, with any `data()` wrapper removed. */
export type SubmissionLoaderData = UnwrapData<Awaited<ReturnType<typeof loader>>>;

/**
 * Unwrap a DIRECT `loader()` call — the shape this suite calls loaders in.
 *
 * React Router strips the `data()` wrapper before a component ever sees it, so
 * nothing in the app needs this. Unit tests that invoke the loader as a plain
 * function do, because they receive whatever the branch actually returned.
 *
 * Exported rather than copied into each test file: eight of them call this
 * loader directly, and eight private copies of the same three lines is how the
 * next status code becomes an eight-file change again.
 */
export function submissionLoaderPayload(
  result: Awaited<ReturnType<typeof loader>>,
): SubmissionLoaderData {
  return (
    result && typeof result === "object" && "data" in result && "init" in result
      ? (result as { data: SubmissionLoaderData }).data
      : result
  ) as SubmissionLoaderData;
}

/**
 * `capture` is optional on the PROP even though the loader always returns it:
 * the zero-state render tests build these props by hand, and a caller with no
 * provenance to pass is asking for the ordinary page, not a broken one.
 */
export type SubmissionDetailViewProps = Omit<
  SubmissionLoaderData,
  "capture" | "candidates" | "roles" | "triage" | "aiAvailable" | "revisions"
> & {
  capture?: CaptureProvenance | null;
  candidates?: CandidateRow[];
  roles?: { value: string; label: string }[];
  /** Optional for the same reason `capture` is — hand-built props in tests. */
  triage?: AiTriageCardData | null;
  aiAvailable?: boolean;
  revisions?: RevisionEntry[];
  actionData?: { ok: false; error: string } | undefined;
};

/**
 * "This did not come through the form, and nobody has been contacted."
 *
 * Rendered above the abstract rather than in the metadata grid: a reviewer
 * about to judge somebody's prose needs to know it is a pasted DM before they
 * read it, not after.
 */
function CaptureBanner({ capture }: { capture: CaptureProvenance }) {
  const when = new Date(capture.capturedAt).toISOString().slice(0, 10);
  return (
    <section
      data-testid="capture-provenance"
      className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm dark:border-amber-800 dark:bg-amber-950"
    >
      <p>
        <strong>Captured on the speaker&rsquo;s behalf</strong> by{" "}
        {capture.byName || "an organizer"} on {when} · from{" "}
        {CAPTURE_SOURCE_LABELS[capture.source]}. Recorded verbatim; nothing was sent to the
        speaker.
      </p>
      {capture.contactName || capture.contactNote ? (
        <p className="mt-1 text-gray-700 dark:text-gray-300">
          {capture.contactName ? <>Contact given as {capture.contactName}. </> : null}
          {capture.contactNote}
        </p>
      ) : null}
    </section>
  );
}

export function SubmissionDetailView({
  event,
  detail,
  speakers,
  candidates = [],
  roles = [],
  answers,
  capture = null,
  tab,
  trackId,
  prev,
  next,
  position,
  rounds,
  triage = null,
  aiAvailable = false,
  revisions = [],
  actionData,
}: SubmissionDetailViewProps) {
  if (!event || !detail) {
    return (
      <LaneStub lane="Not found">
        That abstract does not exist in this event.{" "}
        <a className={linkClass} href={listUrl(tab, trackId)}>
          Back to {tabFor(tab).label}
        </a>
        .
      </LaneStub>
    );
  }

  const here = detailUrl(detail.id, tab, trackId);

  return (
    <div className="space-y-4">
      {/* ── header: identity, status, and the walk through the tab ─────── */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <a className="text-sm text-gray-500 underline" href={listUrl(tab, trackId)}>
            ← Abstracts · {tabFor(tab).label}
          </a>
          <h2 className="mt-1 text-xl font-semibold break-words">{detail.title}</h2>
          <p className="text-sm text-gray-500">
            <span className="font-mono">{detail.friendlyId ?? "unnumbered draft"}</span>
            {position ? ` · ${position.index} of ${position.total} in ${tabFor(tab).label}` : null}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <a
            href={prev ? detailUrl(prev.id, tab, trackId) : undefined}
            aria-disabled={prev ? undefined : "true"}
            data-testid="detail-prev"
            className={`${GHOST_BUTTON} ${prev ? "" : "pointer-events-none opacity-40"}`}
          >
            ‹ Prev
          </a>
          <a
            href={next ? detailUrl(next.id, tab, trackId) : undefined}
            aria-disabled={next ? undefined : "true"}
            data-testid="detail-next"
            className={`${GHOST_BUTTON} ${next ? "" : "pointer-events-none opacity-40"}`}
          >
            Next ›
          </a>
          <div data-testid="detail-status">
            <StatusCell
              sessionId={detail.id}
              status={detail.status}
              tab={tab}
              trackId={trackId}
              returnTo={here}
            />
          </div>
        </div>
      </div>

      {actionData && !actionData.ok ? (
        <p className="rounded border border-red-300 bg-red-50 p-3 text-sm text-red-700 dark:border-red-800 dark:bg-red-950 dark:text-red-200">
          {actionData.error}
        </p>
      ) : null}

      {capture ? <CaptureBanner capture={capture} /> : null}

      {/* ── the facts a reviewer decides on ─────────────────────────────── */}
      <dl className={`grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6 ${CARD}`}>
        <Meta label="Status">
          <StatusPill status={detail.status} />
        </Meta>
        <Meta label="Track">
          {detail.trackName ? (
            <span
              className="rounded-full px-2 py-0.5 text-xs"
              style={
                detail.trackColor
                  ? { backgroundColor: `${detail.trackColor}22`, color: detail.trackColor }
                  : undefined
              }
            >
              {detail.trackName}
            </span>
          ) : (
            "—"
          )}
        </Meta>
        <Meta label="Format">{detail.formatName ?? "—"}</Meta>
        <Meta label="Level">{detail.levelName ?? "—"}</Meta>
        <Meta label="Source">
          {detail.formId ? (
            <a className={linkClass} href={`/submit/${event.slug}/${detail.formId}`}>
              {detail.formName}
            </a>
          ) : (
            detail.formName
          )}
        </Meta>
        <Meta label="Submitted">{formatDate(detail.submittedAt)}</Meta>
      </dl>

      {/* ── the abstract itself: the thing the table had no room for ────── */}
      <section className={CARD} data-testid="detail-abstract">
        {/*
         * The shared eyebrow, and a MEASURE on the prose. This card sat at the
         * container's full 1104px, so the one block of running text a reviewer
         * has to actually read set at ~165 characters per line — roughly twice
         * the width the eye can track back from without losing the row.
         */}
        <h3 className={`mb-2 ${eyebrowClass}`}>Abstract</h3>
        {detail.abstract ? (
          detail.abstract.split(/\n{2,}/).map((paragraph, index) => (
            <p key={index} className="mb-3 max-w-prose text-sm leading-relaxed whitespace-pre-line">
              {paragraph}
            </p>
          ))
        ) : (
          <p className="text-sm text-gray-500">
            This submission has no abstract text — check the video pitch below.
          </p>
        )}

        <details className={`${CARD} mt-4`} data-testid="abstract-edit-details">
          <summary className="cursor-pointer font-semibold">Edit title and abstract</summary>
          <form method="post" className="mt-4 space-y-4" data-abstract-edit-form>
            <input type="hidden" name="intent" value="edit-abstract" />
            <input type="hidden" name="tab" value={tab} />
            <input type="hidden" name="track" value={trackId ?? ""} />
            <label className="block text-sm">
              Title
              <input
                name="title"
                required
                maxLength={200}
                defaultValue={detail.title}
                className={`mt-1 block w-full ${FIELD}`}
              />
            </label>
            <label className="block text-sm">
              Abstract
              <textarea
                name="abstract"
                rows={8}
                defaultValue={detail.abstract}
                className={`mt-1 block w-full ${FIELD}`}
              />
            </label>
            <button type="submit" className={GHOST_BUTTON}>
              Save title and abstract
            </button>
            {detail.composedIntoSessionId ? (
              <p className="text-xs text-gray-500">
                Saved changes also update the composed programme session and the public schedule.
              </p>
            ) : null}
          </form>
        </details>

        <div className={`${CARD} mt-4`}>
          <RevisionHistory
            entries={revisions}
            hiddenFields={{ tab, track: trackId ?? "" }}
            canRestore
          />
        </div>

        {detail.videoUrl || detail.externalUrl ? (
          <p className="mt-2 text-sm" data-testid="detail-media">
            {detail.videoUrl ? (
              <a className={linkClass} href={detail.videoUrl}>
                Video pitch
              </a>
            ) : null}
            {detail.videoUrl && detail.externalUrl ? " · " : null}
            {detail.externalUrl ? (
              <a className={linkClass} href={`/api/uploads/${detail.externalUrl}`}>
                Uploaded file
              </a>
            ) : null}
          </p>
        ) : null}
      </section>

      {/* ── the model's first pass, kept apart from the human scorecards ── */}
      <AiTriageCard
        className={CARD}
        triage={triage}
        aiAvailable={aiAvailable}
        tab={tab}
        trackId={trackId}
      />

      <section className={CARD} data-testid="review-scorecards">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h3 className={eyebrowClass}>Review scorecards</h3>
            <p className="mt-1.5 max-w-prose text-sm text-gray-500">
              Score this submission in each programme round. Weighted totals are saved per reviewer.
            </p>
          </div>
          <form method="post" className="flex items-end gap-2">
            <input type="hidden" name="intent" value="create-review-round" />
            <input type="hidden" name="tab" value={tab} />
            {trackId ? <input type="hidden" name="track" value={trackId} /> : null}
            <label className="text-xs text-gray-500">
              Next round name
              <input name="name" placeholder={rounds.length ? `Round ${rounds.length + 1}` : "Round 1"}
                className="ml-2 rounded border border-gray-300 px-2 py-1 text-sm dark:border-gray-700 dark:bg-gray-900" />
            </label>
            <button type="submit" className={GHOST_BUTTON}>
              {rounds.length ? "Add next round" : "Create first round"}
            </button>
          </form>
        </div>
        {rounds.length === 0 ? (
          <div className="mt-4 rounded-lg border border-dashed border-gray-300 p-6 text-center dark:border-gray-700">
            <p className="text-sm font-medium">No review rounds yet</p>
            <p className="mx-auto mt-1 max-w-sm text-sm text-gray-500 dark:text-gray-400">
              Create the first round above and its rubric appears here, ready to score.
            </p>
          </div>
        ) : (
          /*
           * Two-up only when there ARE two. With a single round the fixed
           * `lg:grid-cols-2` gave the one scorecard the left half of an 1104px
           * card and left 550px of white beside it — the most-used control on
           * the review path, floating in half a page.
           */
          <div className={`mt-4 grid gap-4 ${rounds.length > 1 ? "lg:grid-cols-2" : "max-w-2xl"}`}>
            {rounds.map((round) => {
              // The list prints the same denominator from the same function.
              const maxScore = rubricMaxTotal(round.rubric);
              return (
                <div key={round.id} className="space-y-3">
                <form method="post"
                  className="space-y-3 rounded border border-gray-200 p-3 dark:border-gray-700"
                  data-testid={`review-round-${round.ordinal}`}>
                  <input type="hidden" name="intent" value="save-review" />
                  <input type="hidden" name="roundId" value={round.id} />
                  <input type="hidden" name="tab" value={tab} />
                  {trackId ? <input type="hidden" name="track" value={trackId} /> : null}
                  <div className="flex items-baseline justify-between gap-2">
                    <h4 className="font-medium">Round {round.ordinal} · {round.name}</h4>
                    <span className="text-sm tabular-nums text-gray-500">
                      {round.review ? `${round.review.totalScore} / ${maxScore}` : `Not scored · / ${maxScore}`}
                    </span>
                  </div>
                  <p className="text-xs text-gray-500">
                    Assigned to {round.assignedTeams.length ? round.assignedTeams.join(", ") : "no team"}
                    {/* The count comes from the aggregate itself, so "N submitted"
                        and the average it precedes always describe the same rows. */}
                    {round.aggregate
                      ? ` · ${round.aggregate.reviewerCount} submitted${
                          round.aggregate.averageScore !== null
                            ? ` · average ${round.aggregate.averageScore.toFixed(1)} / ${maxScore}`
                            : ""
                        }`
                      : " · no submitted reviews"}
                  </p>
                  {round.choices.length > 0 ? (
                    <ul data-testid={`round-choices-${round.ordinal}`} className="space-y-0.5 text-xs text-gray-600 dark:text-gray-400">
                      {round.choices.map((choice) => (
                        <li key={choice.key}>
                          {choice.label}: {choice.tallies.map((tally) => `${tally.option} ${tally.count}`).join(" · ")}
                          {choice.modal !== null ? ` — most common: ${choice.modal}` : ""}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                  {!round.canReview ? (
                    <p className="rounded bg-amber-50 p-2 text-xs text-amber-800 dark:bg-amber-950 dark:text-amber-200">
                      Your reviewer teams are not assigned to this submission in this round.
                    </p>
                  ) : null}
                  {round.rubric.criteria.map((criterion) => {
                    const isSelect = isSelectCriterion(criterion);
                    const isText = isTextCriterion(criterion);
                    return (
                      /*
                       * `max-w-md` on the row, not `1fr` across the card. A
                       * criterion label and its 0–5 box do not need 640px
                       * between them; at full width the scorecard read as a
                       * table of contents with the answers filed at the far
                       * margin, which is the pattern leader dots exist to
                       * paper over.
                       */
                      <label key={criterion.key} className="grid max-w-md grid-cols-[1fr_6rem] items-center gap-3 text-sm">
                        <span>{criterion.label}{!isUnscoredCriterion(criterion) && criterion.weight !== 1 ? (
                          <span className="ml-1 text-xs text-gray-500">×{criterion.weight}</span>
                        ) : null}</span>
                        {isText ? (
                          <textarea name={`score-${criterion.key}`} rows={2} disabled={!round.canReview}
                            defaultValue={typeof round.review?.scores[criterion.key] === "string" ? String(round.review.scores[criterion.key]) : ""}
                            aria-label={`${round.name}: ${criterion.label}`}
                            className="rounded border border-gray-300 px-2 py-1.5 dark:border-gray-700 dark:bg-gray-900" />
                        ) : isSelect ? (
                          <select name={`score-${criterion.key}`} required disabled={!round.canReview}
                            defaultValue={typeof round.review?.scores[criterion.key] === "string" ? String(round.review.scores[criterion.key]) : ""}
                            aria-label={`${round.name}: ${criterion.label}`}
                            className="rounded border border-gray-300 px-2 py-1.5 dark:border-gray-700 dark:bg-gray-900">
                            <option value="">Select…</option>
                            {(criterion.options ?? []).map((option) => (
                              <option key={option} value={option}>{option}</option>
                            ))}
                          </select>
                        ) : (
                          <input type="number" name={`score-${criterion.key}`} min={criterion.min}
                            max={criterion.max} step="any" required disabled={!round.canReview}
                            defaultValue={round.review?.scores[criterion.key]}
                            aria-label={`${round.name}: ${criterion.label}`}
                            className="rounded border border-gray-300 px-2 py-1.5 dark:border-gray-700 dark:bg-gray-900" />
                        )}
                      </label>
                    );
                  })}
                  <label className="block text-sm">Private reviewer note
                    <textarea name="comment" rows={2} disabled={!round.canReview} defaultValue={round.review?.comment}
                      className="mt-1 w-full rounded border border-gray-300 px-2 py-1.5 dark:border-gray-700 dark:bg-gray-900" />
                  </label>
                  <button type="submit" disabled={!round.canReview} className={GHOST_BUTTON}>{round.review ? "Update score" : "Submit score"}</button>
                </form>
                {round.submittedReviews.length > 0 ? (
                  <section
                    data-testid={`round-${round.ordinal}-reviews`}
                    className="rounded border border-gray-200 p-3 dark:border-gray-700"
                  >
                    <h4 className="text-sm font-semibold">Reviewer scores and comments</h4>
                    <ul className="mt-2 space-y-3">
                      {round.submittedReviews.map((entry) => (
                        <li key={entry.reviewerId} className="border-t border-gray-100 pt-3 first:border-0 first:pt-0 dark:border-gray-800">
                          <div className="flex flex-wrap items-baseline justify-between gap-2">
                            <span className="text-sm font-medium">{entry.reviewerName}</span>
                            <span className="text-xs tabular-nums text-gray-500">
                              {entry.totalScore} / {maxScore} · {new Date(entry.submittedAt).toISOString().replace("T", " ").slice(0, 16)} UTC
                            </span>
                          </div>
                          <dl className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-gray-600 dark:text-gray-300">
                            {round.rubric.criteria.map((criterion) => (
                              <div key={criterion.key} className="flex gap-1">
                                <dt>{criterion.label}</dt>
                                <dd className="font-medium tabular-nums">{entry.scores[criterion.key] ?? "—"}</dd>
                              </div>
                            ))}
                          </dl>
                          <p className="mt-1 text-sm whitespace-pre-wrap">
                            {entry.comment.trim() || <span className="text-gray-500 italic">No comment left.</span>}
                          </p>
                        </li>
                      ))}
                    </ul>
                  </section>
                ) : null}
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* ── the answers to whatever else the form asked ─────────────────── */}
      <section className={CARD} data-testid="detail-answers">
        <h3 className={`mb-2 ${eyebrowClass}`}>Form answers</h3>
        {answers.length === 0 ? (
          <p className="text-sm text-gray-500">
            This form asked no questions beyond the title and abstract.
          </p>
        ) : (
          <dl className="space-y-3">
            {answers.map((answer) => (
              <div key={answer.key} data-testid={`answer-${answer.key}`}>
                <dt className={eyebrowClass}>
                  {answer.label}
                  {answer.offSchema ? (
                    <span className="ml-2 rounded bg-gray-100 px-1.5 py-0.5 text-[10px] normal-case dark:bg-gray-800">
                      no longer asked
                    </span>
                  ) : null}
                </dt>
                <dd className="mt-0.5 max-w-prose text-sm break-words whitespace-pre-line">
                  {answer.value}
                </dd>
              </div>
            ))}
          </dl>
        )}
      </section>

      {/* ── who is speaking, with enough to judge them ──────────────────── */}
      <section className={CARD} data-testid="detail-speakers">
        <h3 className={`mb-2 ${eyebrowClass}`}>
          {speakers.length === 1 ? "Speaker" : `Speakers (${speakers.length})`}
        </h3>
        {speakers.length === 0 ? (
          <p className="text-sm text-gray-500">
            Nobody is attached to this submission yet — it was added by hand.
          </p>
        ) : (
          <ul className="divide-y divide-gray-100 dark:divide-gray-800">
            {speakers.map((speaker) => (
              <li
                key={speaker.personId}
                className="py-3 first:pt-0 last:pb-0"
                data-participant-row={speaker.personId}
              >
                <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                  <a
                    className={linkClass}
                    href={`/admin/speakers/${speaker.personId}`}
                  >
                    {speaker.name}
                  </a>
                  <span className="rounded bg-gray-100 px-1.5 py-0.5 text-xs dark:bg-gray-800">
                    {speaker.role.replace(/_/g, " ")}
                    {speaker.isPrimary ? " · submitter" : ""}
                  </span>
                  <span className="text-sm text-gray-500">
                    {[speaker.title, speaker.company].filter(Boolean).join(", ") || speaker.email}
                  </span>
                  {speaker.isPrimary ? (
                    <span className="ml-auto text-xs text-gray-500">Submitter</span>
                  ) : (
                    <form method="post" className="ml-auto">
                      <input type="hidden" name="intent" value="remove-participant" />
                      <input type="hidden" name="personId" value={speaker.personId} />
                      <input type="hidden" name="tab" value={tab} />
                      <input type="hidden" name="track" value={trackId ?? ""} />
                      <button type="submit" className={GHOST_BUTTON}>
                        Remove
                      </button>
                    </form>
                  )}
                </div>
                {speaker.bio ? (
                  <p className="mt-1 text-sm leading-relaxed text-gray-600 dark:text-gray-300">
                    {speaker.bio}
                  </p>
                ) : (
                  <p className="mt-1 text-sm text-gray-500 italic">No bio yet.</p>
                )}
                {speaker.links.length ? (
                  <p className="mt-1 flex flex-wrap gap-3 text-sm">
                    {speaker.links.map(([label, href]) => {
                      const resolvedHref = socialHref(href);
                      return resolvedHref ? (
                        <a key={label} className={linkClass} href={resolvedHref} rel="noreferrer">
                          {label}
                        </a>
                      ) : (
                        <span key={label} className="text-gray-500 dark:text-gray-400">
                          {label}
                        </span>
                      );
                    })}
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
        )}

        {roles.length > 0 ? (
          candidates.length === 0 ? (
            <p className="mt-4 text-sm text-gray-500">
              Everyone on this event&apos;s roster is already on this submission.
            </p>
          ) : (
            <form
              method="post"
              className="mt-4 flex flex-wrap items-end gap-2"
              data-add-participant-form
            >
              <input type="hidden" name="intent" value="add-participant" />
              <input type="hidden" name="tab" value={tab} />
              <input type="hidden" name="track" value={trackId ?? ""} />
              <label className="flex min-w-48 flex-1 flex-col gap-1 text-xs">
                Person
                <select name="personId" required className={FIELD}>
                  {candidates.map((candidate) => (
                    <option key={candidate.personId} value={candidate.personId}>
                      {candidate.name} — {candidate.email}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex flex-col gap-1 text-xs">
                Role
                <select name="role" defaultValue="speaker" className={FIELD}>
                  {roles.map((role) => (
                    <option key={role.value} value={role.value}>
                      {role.label}
                    </option>
                  ))}
                </select>
              </label>
              <button type="submit" className={GHOST_BUTTON}>
                Add speaker
              </button>
            </form>
          )
        ) : null}
      </section>

      {detail.composedIntoSessionId ? (
        <p className="text-xs text-gray-500">
          Accepted and composed into a program session
          {detail.roomName ? ` in ${detail.roomName}` : ""}. Status here stays{" "}
          {statusLabel(detail.status)}; scheduling happens on the agenda.
        </p>
      ) : null}
    </div>
  );
}

export default function AdminSubmissionDetail({ loaderData, actionData }: Route.ComponentProps) {
  return <SubmissionDetailView {...loaderData} actionData={actionData ?? undefined} />;
}
