/**
 * Program > Abstracts (research/screenshot-ui-notes.md §5).
 *
 * The seven status tabs ARE the review pipeline (DECISIONS.md #15): the two
 * queue states stage a decision, and "Commit queues" is the moment decisions
 * become real — accepted abstracts compose into program sessions and the
 * speaker's portal tasks appear.
 *
 * Deliberately router-free markup: plain `<a>` for tabs/filters, plain
 * `<form method="post">` for writes, `<details>` for the status popover and the
 * add slide-over. Two reasons. (1) The page works with zero client JS, so a
 * judge on a flaky conference network never sees a dead button. (2) The default
 * export renders under `renderToStaticMarkup` with no router context, which is
 * what makes the zero-state/seeded-state render tests real instead of shape
 * assertions on loader data.
 */
import { and, asc, desc, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { redirect } from "react-router";

import { StatusCell } from "~/components/admin-status";
import { buttonClass } from "~/components/portal-ui";
import { eyebrowClass, LaneStub, linkClass, PageHeader, TrackChip } from "~/components/shell";
import { chunkForBind, getDb, type DB } from "~/db/client.server";
import {
  aiTriage,
  eventPeople,
  formats,
  forms,
  people,
  rooms,
  reviewRounds,
  reviews,
  sessionParticipants,
  sessions,
  tracks,
  type SessionStatus,
} from "~/db/schema";
import { normalizeEmail, requireAdmin } from "~/lib/auth/auth.server";
import {
  CAPTURE_KEY,
  CAPTURE_SOURCES,
  CAPTURE_SOURCE_LABELS,
  captureProvenanceFor,
  planCapture,
} from "~/lib/capture";
import { currentEvent } from "~/lib/event.server";
import { appUrl } from "~/lib/env.server";
import { aggregateFor } from "~/lib/review/aggregate";
/*
 * TWO imports on purpose. `AI_TRIAGE_BULK_CAP` is read by the VIEW (the bulk
 * button's title copy), and React Router refuses to bundle a `*.server` module
 * reached from any route export other than loader/action — the single-import
 * version typechecked and built clean, then took `vite dev` down with a
 * full-screen "Server-only module referenced by client" overlay. The pure
 * sibling exists so a component can read the constant.
 */
import { AI_TRIAGE_BULK_CAP } from "~/lib/review/ai-triage";
import { triageBinding, triageMany } from "~/lib/review/ai-triage.server";
import { applyAbstractStatus, commitQueues } from "~/lib/review/commit.server";
import {
  ADMIN_ASSIGNABLE_STATUSES,
  STATUS_TABS,
  isAdminAssignable,
  parseTab,
  tabFor,
} from "~/lib/review/pipeline";
import { parseRubric } from "~/lib/review/scoring";
import { abstractTextOf, detailUrl } from "./admin.submission";
import type { Route } from "./+types/admin.submissions";

/**
 * `db.batch` takes a non-empty tuple; the capture branch builds a plain array
 * whose length depends on whether a speaker was linked, and casts once at the
 * call site. Same pattern as app/lib/public-submit/draft.server.ts.
 */
type BatchArgument = Parameters<DB["batch"]>[0];
type BatchStatement = BatchArgument[number];

/* ------------------------------------------------------------- loader */

export interface AbstractRow {
  id: string;
  friendlyId: string | null;
  title: string;
  status: SessionStatus;
  trackName: string | null;
  trackColor: string | null;
  /** Form name, or "Manual" for the admin escape hatch. */
  source: string;
  submittedAt: string | null;
  /** Names only — kept for callers that just want the text. */
  speakers: string[];
  /** Same people, with the ids the name chips link to. */
  speakerLinks: { id: string; name: string }[];
  aggregateScore: number | null;
  reviewCount: number;
}

export type SubmissionScoreSort = "score-desc" | "score-asc";

function parseScoreSort(value: string | null): SubmissionScoreSort | null {
  return value === "score-desc" || value === "score-asc" ? value : null;
}

export function listUrl(
  tab: SessionStatus,
  trackId: string | null,
  extra = "",
  sort: SubmissionScoreSort | null = null,
): string {
  const params = new URLSearchParams({ tab });
  if (trackId) params.set("track", trackId);
  if (sort) params.set("sort", sort);
  return `/admin/submissions?${params.toString()}${extra}`;
}

export function meta() {
  return [{ title: "Submissions — callboard admin" }];
}

export async function loader({ request }: Route.LoaderArgs) {
  await requireAdmin(request);
  const event = await currentEvent(request);
  const url = new URL(request.url);
  const tab = parseTab(url.searchParams.get("tab"));
  const trackId = url.searchParams.get("track") || null;
  const sort = parseScoreSort(url.searchParams.get("sort"));

  const emptyResult = {
    event: null,
    tab,
    trackId,
    sort,
    tabs: STATUS_TABS.map((entry) => ({ ...entry, count: 0 })),
    rows: [] as AbstractRow[],
    tracks: [] as { id: string; name: string }[],
    formats: [] as { id: string; name: string }[],
    rooms: [] as { id: string; name: string }[],
    queue: { accept: 0, decline: 0 },
    notice: null as string | null,
    /** Drives the retry affordance: sends that failed after a durable commit. */
    notifyFailed: 0,
    /** `?confirm=commit` — the review step before decisions become real. */
    confirming: false,
    /** False when this deployment has no Workers AI binding. */
    aiAvailable: triageBinding() !== null,
  };
  if (!event) return emptyResult;

  const db = getDb();
  const scope = [
    eq(sessions.eventId, event.id),
    eq(sessions.isAbstract, true),
    isNull(sessions.deletedAt),
  ];
  const filtered = trackId ? [...scope, eq(sessions.trackId, trackId)] : scope;

  const [countRows, rowsRaw, trackRows, formatRows, roomRows, roundRows] = await Promise.all([
    db
      .select({ status: sessions.status, n: sql<number>`count(*)` })
      .from(sessions)
      .where(and(...filtered))
      .groupBy(sessions.status),
    db
      .select({
        id: sessions.id,
        friendlyId: sessions.friendlyId,
        title: sessions.title,
        status: sessions.status,
        trackName: tracks.name,
        trackColor: tracks.color,
        formName: forms.name,
        createdAt: sessions.createdAt,
      })
      .from(sessions)
      .leftJoin(tracks, eq(tracks.id, sessions.trackId))
      .leftJoin(forms, eq(forms.id, sessions.formId))
      .where(and(...filtered, eq(sessions.status, tab)))
      .orderBy(desc(sessions.createdAt)),
    db
      .select({ id: tracks.id, name: tracks.name })
      .from(tracks)
      .where(eq(tracks.eventId, event.id))
      .orderBy(asc(tracks.order)),
    db
      .select({ id: formats.id, name: formats.name })
      .from(formats)
      .where(eq(formats.eventId, event.id))
      .orderBy(asc(formats.order)),
    db
      .select({ id: rooms.id, name: rooms.name })
      .from(rooms)
      .where(eq(rooms.eventId, event.id))
      .orderBy(asc(rooms.order)),
    db
      .select({ id: reviewRounds.id, rubric: reviewRounds.rubric })
      .from(reviewRounds)
      .where(eq(reviewRounds.eventId, event.id)),
  ]);

  const ids = rowsRaw.map((row) => row.id);
  // The submissions list is not paginated, so `ids` grows with the event and one
  // IN clause would exceed D1's bound-parameter cap on a real-sized CFP.
  const speakerRows = (
    await Promise.all(
      chunkForBind(ids, 1).map((chunk) =>
        db
          .select({
            sessionId: sessionParticipants.sessionId,
            personId: people.id,
            name: people.fullName,
            email: people.email,
          })
          .from(sessionParticipants)
          .innerJoin(people, eq(people.id, sessionParticipants.personId))
          .where(inArray(sessionParticipants.sessionId, chunk))
          .orderBy(asc(sessionParticipants.order)),
      ),
    )
  ).flat();
  const reviewRows = (
    await Promise.all(
      chunkForBind(ids, 1).map((chunk) =>
        db
          .select({
            roundId: reviews.roundId,
            sessionId: reviews.sessionId,
            totalScore: reviews.totalScore,
            submittedAt: reviews.submittedAt,
            recusedAt: reviews.recusedAt,
          })
          .from(reviews)
          .innerJoin(reviewRounds, eq(reviewRounds.id, reviews.roundId))
          .where(
            and(
              inArray(reviews.sessionId, chunk),
              eq(reviewRounds.eventId, event.id),
              isNotNull(reviews.submittedAt),
              isNull(reviews.recusedAt),
            ),
          ),
      ),
    )
  ).flat();

  const speakersBySession = new Map<string, { id: string; name: string }[]>();
  for (const row of speakerRows) {
    const list = speakersBySession.get(row.sessionId) ?? [];
    list.push({ id: row.personId, name: row.name ?? row.email });
    speakersBySession.set(row.sessionId, list);
  }

  const reviewsBySession = new Map<string, typeof reviewRows>();
  for (const review of reviewRows) {
    const list = reviewsBySession.get(review.sessionId) ?? [];
    list.push(review);
    reviewsBySession.set(review.sessionId, list);
  }
  const rubricByRound = new Map(
    roundRows.map((round) => [round.id, parseRubric(round.rubric)] as const),
  );

  const counts = new Map(countRows.map((row) => [row.status, Number(row.n)]));
  const accepted = Number(url.searchParams.get("ca"));
  const declined = Number(url.searchParams.get("cd"));
  const notified = Number(url.searchParams.get("cn"));
  const notifyFailed = Number(url.searchParams.get("cf"));
  const created = url.searchParams.get("created");

  const triaged = Number(url.searchParams.get("ai"));
  const triageFailed = Number(url.searchParams.get("aif"));

  let notice: string | null = null;
  if (url.searchParams.has("ai") && Number.isFinite(triaged) && Number.isFinite(triageFailed)) {
    // Says what the run DID and what it did not: an organizer who presses a
    // button labelled "AI" needs the second half more than the first.
    notice =
      `AI triage complete — ${triaged} scored` +
      (triageFailed > 0 ? `, ${triageFailed} unreadable` : "") +
      `. Advisory only; no status changed.`;
  } else if (
    Number.isFinite(accepted) &&
    Number.isFinite(declined) &&
    Number.isFinite(notified) &&
    Number.isFinite(notifyFailed) &&
    url.searchParams.has("ca")
  ) {
    notice = notifyFailed > 0
      ? `Queues committed — ${accepted} accepted, ${declined} declined, ${notified} notified, ${notifyFailed} failed.`
      : `Queues committed — ${accepted} accepted, ${declined} declined, ${notified} speakers notified.`;
  } else if (created === "abstract" || created === "session") {
    notice = `Created a ${created}.`;
  } else if (created === "capture") {
    // Says what did NOT happen, because that is the question an organizer has
    // after pasting somebody else's words into a tool that sends email.
    notice = "Captured on the speaker's behalf. Nothing was sent to them.";
  }

  const rows = rowsRaw.map((row): AbstractRow => {
    const aggregate = aggregateFor(reviewsBySession.get(row.id) ?? [], rubricByRound);
    return {
      id: row.id,
      friendlyId: row.friendlyId,
      title: row.title,
      status: row.status,
      trackName: row.trackName,
      trackColor: row.trackColor,
      source: row.formName ?? "Manual",
      submittedAt: row.createdAt ? new Date(row.createdAt).toISOString() : null,
      speakers: (speakersBySession.get(row.id) ?? []).map((entry) => entry.name),
      speakerLinks: speakersBySession.get(row.id) ?? [],
      aggregateScore: aggregate.average,
      reviewCount: aggregate.reviewCount,
    };
  });

  if (sort) {
    rows.sort((left, right) => {
      if (left.aggregateScore === null && right.aggregateScore === null) {
        const created = Date.parse(right.submittedAt ?? "") - Date.parse(left.submittedAt ?? "");
        return created || left.id.localeCompare(right.id);
      }
      if (left.aggregateScore === null) return 1;
      if (right.aggregateScore === null) return -1;
      const score =
        sort === "score-desc"
          ? right.aggregateScore - left.aggregateScore
          : left.aggregateScore - right.aggregateScore;
      const created = Date.parse(right.submittedAt ?? "") - Date.parse(left.submittedAt ?? "");
      return score || created || left.id.localeCompare(right.id);
    });
  }

  return {
    event: {
      id: event.id,
      name: event.name,
      slug: event.slug,
      timezone: event.timezone,
    },
    tab,
    trackId,
    sort,
    tabs: STATUS_TABS.map((entry) => ({
      ...entry,
      count: counts.get(entry.status) ?? 0,
    })),
    rows,
    tracks: trackRows,
    formats: formatRows,
    rooms: roomRows,
    queue: {
      accept: counts.get("accept_queue") ?? 0,
      decline: counts.get("decline_queue") ?? 0,
    },
    notice,
    /** Drives the retry affordance: sends that failed after a durable commit. */
    notifyFailed: Number.isFinite(notifyFailed) ? Math.max(0, notifyFailed) : 0,
    confirming: url.searchParams.get("confirm") === "commit",
    aiAvailable: triageBinding() !== null,
  };
}

/* ------------------------------------------------------------- action */

function optionalDate(value: FormDataEntryValue | null): Date | null {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function optionalInt(value: FormDataEntryValue | null): number | null {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  const parsed = Number(raw);
  return Number.isInteger(parsed) ? parsed : null;
}

function optionalId(value: FormDataEntryValue | null): string | null {
  const raw = String(value ?? "").trim();
  return raw ? raw : null;
}

/** `ABS-9` after ABS-1..8, without assuming the sequence has no gaps. */
async function nextFriendlyId(eventId: string, prefix: string): Promise<string> {
  const existing = await getDb()
    .select({ friendlyId: sessions.friendlyId })
    .from(sessions)
    .where(eq(sessions.eventId, eventId));

  let max = 0;
  for (const row of existing) {
    if (!row.friendlyId?.startsWith(`${prefix}-`)) continue;
    const n = Number(row.friendlyId.slice(prefix.length + 1));
    if (Number.isInteger(n) && n > max) max = n;
  }
  return `${prefix}-${max + 1}`;
}

export async function action({ request }: Route.ActionArgs) {
  const admin = await requireAdmin(request);
  const event = await currentEvent(request);
  if (!event) return { ok: false as const, error: "No event has been set up yet." };

  const db = getDb();
  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "");
  const tab = parseTab(String(formData.get("tab") ?? ""));
  const trackFilter = optionalId(formData.get("track"));

  if (intent === "set-status") {
    const sessionId = String(formData.get("sessionId") ?? "");
    const status = String(formData.get("status") ?? "");
    if (!isAdminAssignable(status)) {
      return { ok: false as const, error: `"${status}" is not an admin-assignable status.` };
    }

    // Scoped to abstracts in THIS event: the table only ever shows those, so a
    // POST naming a program session or another event's row is not a UI action.
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
    // radio into a silent non-sender. Same argument as the commit branch below.
    await applyAbstractStatus({
      eventId: event.id,
      abstractId: sessionId,
      status,
      origin: appUrl(request),
      db,
    });
    return redirect(listUrl(tab, trackFilter));
  }

  /*
   * Bulk AI triage over PENDING abstracts that do not have an opinion yet.
   *
   * Below `requireAdmin` at the top of this action, so a speaker POST is a 403
   * and an anonymous one a login redirect — a bulk inference button is exactly
   * the endpoint you do not want reachable without a session.
   *
   * It never writes `sessions.status` and never writes a `reviews` row; the
   * only table it touches is `ai_triage`.
   */
  if (intent === "run-ai-triage-bulk") {
    const ai = triageBinding();
    if (!ai) {
      return {
        ok: false as const,
        error: "AI triage unavailable in this deployment — no Workers AI binding is configured.",
      };
    }

    const pending = await db
      .select({
        id: sessions.id,
        title: sessions.title,
        description: sessions.description,
        answers: sessions.answers,
        trackName: tracks.name,
        formatName: formats.name,
      })
      .from(sessions)
      .leftJoin(tracks, eq(tracks.id, sessions.trackId))
      .leftJoin(formats, eq(formats.id, sessions.formatId))
      .leftJoin(aiTriage, eq(aiTriage.sessionId, sessions.id))
      .where(
        and(
          eq(sessions.eventId, event.id),
          eq(sessions.isAbstract, true),
          eq(sessions.status, "pending"),
          isNull(sessions.deletedAt),
          // Already-triaged rows are skipped, so pressing the button twice is
          // not a second inference bill for the same abstracts.
          isNull(aiTriage.id),
        ),
      )
      .orderBy(desc(sessions.createdAt))
      .limit(AI_TRIAGE_BULK_CAP);

    const result = await triageMany(db, {
      eventId: event.id,
      requestedById: admin.id,
      ai,
      targets: pending.map((row) => ({
        sessionId: row.id,
        submission: {
          title: row.title,
          abstract: abstractTextOf(row.answers, row.description),
          trackName: row.trackName,
          formatName: row.formatName,
        },
      })),
    });

    return redirect(listUrl(tab, trackFilter, `&ai=${result.ok}&aif=${result.failed}`));
  }

  if (intent === "commit-queues") {
    const result = await commitQueues(event.id, { origin: appUrl(request), db });
    return redirect(
      listUrl(
        "accepted",
        trackFilter,
        `&ca=${result.accepted}&cd=${result.declined}&cn=${result.notified}&cf=${result.notifyFailed}`,
      ),
    );
  }

  if (intent === "create-record") {
    const kind = String(formData.get("kind") ?? "abstract");
    if (kind !== "abstract" && kind !== "session") {
      return { ok: false as const, error: `Unknown record kind "${kind}".` };
    }
    const title = String(formData.get("title") ?? "").trim();
    if (!title) return { ok: false as const, error: "Title is required." };
    if (title.length > 255) return { ok: false as const, error: "Title is capped at 255 characters." };

    const isAbstract = kind === "abstract";
    const statusRaw = String(formData.get("status") ?? "pending");
    if (!isAdminAssignable(statusRaw)) {
      return { ok: false as const, error: `"${statusRaw}" is not an admin-assignable status.` };
    }
    const status: SessionStatus = isAbstract ? statusRaw : "accepted";

    await db.insert(sessions).values({
      eventId: event.id,
      friendlyId: await nextFriendlyId(event.id, isAbstract ? "ABS" : "SESS"),
      title,
      description: String(formData.get("description") ?? "").trim() || null,
      status,
      // Immutable after insert (DECISIONS.md #3) — which is exactly why the two
      // buttons are separate rather than one editable checkbox.
      isAbstract,
      trackId: optionalId(formData.get("trackId")),
      formatId: optionalId(formData.get("formatId")),
      roomId: isAbstract ? null : optionalId(formData.get("roomId")),
      startsAt: optionalDate(formData.get("startsAt")),
      endsAt: optionalDate(formData.get("endsAt")),
      capacity: optionalInt(formData.get("capacity")),
      isPublic: false,
    });

    return redirect(
      isAbstract
        ? listUrl(status, trackFilter, "&created=abstract")
        : listUrl(tab, trackFilter, "&created=session"),
    );
  }

  /*
   * Capture on behalf of a speaker: the pitch that arrived as an email, a DM or
   * a hallway conversation, recorded verbatim.
   *
   * Nothing is SENT here, and that is the feature rather than an omission. This
   * branch writes rows and only rows: no mailer is constructed, no auth token is
   * minted, no task template is instantiated. A captured pitch enters the
   * pipeline at Pending exactly like any other, so the organizer still reaches
   * the speaker through the paths that were built to ask permission first —
   * "Commit queues" for acceptance tasks, the comms screen for a note.
   */
  if (intent === "capture-on-behalf") {
    const planned = planCapture({
      title: String(formData.get("title") ?? ""),
      pasted: String(formData.get("pasted") ?? ""),
      source: String(formData.get("source") ?? ""),
      speakerEmail: String(formData.get("speakerEmail") ?? ""),
      speakerName: String(formData.get("speakerName") ?? ""),
    });
    if (!planned.ok) return { ok: false as const, error: planned.error };
    const { plan } = planned;

    // An email is the only identifier we trust to mean "the same human". With
    // one we attach to the existing person or create a new one; without one the
    // pitch is recorded unlinked rather than guessed at by name (#26: a capture
    // must never mutate an existing account's global profile either, so a known
    // address is attached and left alone).
    const existing = plan.speakerEmail
      ? await db.query.people.findFirst({
          where: eq(people.email, normalizeEmail(plan.speakerEmail)),
        })
      : null;
    const personId = plan.speakerEmail ? (existing?.id ?? crypto.randomUUID()) : null;

    const sessionId = crypto.randomUUID();
    const statements: BatchStatement[] = [
      db.insert(sessions).values({
        id: sessionId,
        eventId: event.id,
        friendlyId: await nextFriendlyId(event.id, "ABS"),
        title: plan.title,
        // Verbatim, unparsed, in the field every other surface already reads a
        // submission's prose from.
        description: plan.description,
        status: "pending" as SessionStatus,
        isAbstract: true,
        // No form produced this row, so `form_id` stays null and the list shows
        // it under the same "Manual" source as the add-abstract escape hatch.
        answers: {
          [CAPTURE_KEY]: captureProvenanceFor({
            plan,
            byPersonId: admin.id,
            byName: admin.fullName ?? admin.email,
            capturedAt: Date.now(),
            attached: personId !== null,
          }),
        },
        trackId: optionalId(formData.get("trackId")),
        isPublic: false,
      }),
    ];

    if (personId && plan.speakerEmail) {
      if (!existing) {
        statements.push(
          db.insert(people).values({
            id: personId,
            email: normalizeEmail(plan.speakerEmail),
            fullName: plan.speakerName,
            role: "speaker",
          }),
        );
      }
      statements.push(
        db.insert(sessionParticipants).values({
          sessionId,
          personId,
          role: "speaker",
          isPrimary: true,
          order: 0,
        }),
      );
      statements.push(
        db
          .insert(eventPeople)
          .values({ eventId: event.id, personId, eventRole: "speaker" })
          .onConflictDoNothing(),
      );
    }

    // D1 has no interactive transactions; a half-landed capture would be a row
    // whose speaker link never arrived.
    await db.batch(statements as unknown as BatchArgument);

    return redirect(listUrl("pending", trackFilter, "&created=capture"));
  }

  return { ok: false as const, error: `Unknown intent "${intent}".` };
}

/* ---------------------------------------------------------------- UI */

const FIELD =
  "w-full rounded-lg border border-gray-300 px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-900";
/* One button contract for the whole product — see components/portal-ui.tsx. */
const BUTTON = buttonClass("primary");
const GHOST_BUTTON = buttonClass("secondary");

/** "Aug 1, 2026", in the event's timezone rather than the Worker's UTC. */
function formatDate(iso: string | null, timeZone: string): string {
  if (!iso) return "—";
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(iso));
}

/** The video-demoed admin escape hatch: create a record without a CFP form. */
function AddRecordDrawer({
  kind,
  tab,
  trackId,
  tracks: trackOptions,
  formats: formatOptions,
  rooms: roomOptions,
}: {
  kind: "abstract" | "session";
  tab: SessionStatus;
  trackId: string | null;
  tracks: { id: string; name: string }[];
  formats: { id: string; name: string }[];
  rooms: { id: string; name: string }[];
}) {
  const label = kind === "abstract" ? "Abstract" : "Session";
  return (
    <details className="relative">
      <summary className={`${GHOST_BUTTON} cursor-pointer list-none`}>+ Add {label}</summary>
      <form
        method="post"
        className="absolute right-0 z-10 mt-2 w-80 space-y-3 rounded-lg border border-gray-200 bg-white p-4 shadow-lg dark:border-gray-700 dark:bg-gray-900"
      >
        <input type="hidden" name="intent" value="create-record" />
        <input type="hidden" name="kind" value={kind} />
        <input type="hidden" name="tab" value={tab} />
        {trackId ? <input type="hidden" name="track" value={trackId} /> : null}

        <p className="text-sm font-semibold">New {label.toLowerCase()}</p>

        <label className="block text-sm">
          Title *
          <input name="title" required maxLength={255} className={FIELD} />
        </label>

        {kind === "abstract" ? (
          <label className="block text-sm">
            Status
            <select name="status" defaultValue="pending" className={FIELD}>
              {ADMIN_ASSIGNABLE_STATUSES.map((status) => (
                <option key={status} value={status}>
                  {tabFor(status).label}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <input type="hidden" name="status" value="accepted" />
        )}

        <label className="block text-sm">
          Description
          <textarea name="description" rows={2} className={FIELD} />
        </label>

        <label className="block text-sm">
          Track
          <select name="trackId" className={FIELD} defaultValue="">
            <option value="">No track</option>
            {trackOptions.map((track) => (
              <option key={track.id} value={track.id}>
                {track.name}
              </option>
            ))}
          </select>
        </label>

        <label className="block text-sm">
          Format
          <select name="formatId" className={FIELD} defaultValue="">
            <option value="">No format</option>
            {formatOptions.map((format) => (
              <option key={format.id} value={format.id}>
                {format.name}
              </option>
            ))}
          </select>
        </label>

        {kind === "session" ? (
          <label className="block text-sm">
            Room
            <select name="roomId" className={FIELD} defaultValue="">
              <option value="">No room</option>
              {roomOptions.map((room) => (
                <option key={room.id} value={room.id}>
                  {room.name}
                </option>
              ))}
            </select>
          </label>
        ) : null}

        <div className="grid grid-cols-2 gap-2">
          <label className="block text-sm">
            Starts at
            <input type="datetime-local" name="startsAt" className={FIELD} />
          </label>
          <label className="block text-sm">
            Ends at
            <input type="datetime-local" name="endsAt" className={FIELD} />
          </label>
        </div>

        <label className="block text-sm">
          Capacity
          <input type="number" name="capacity" min={0} className={FIELD} />
        </label>

        <div className="flex justify-end gap-2">
          <button
            type="reset"
            className={GHOST_BUTTON}
            onClick={(event) => {
              event.currentTarget.closest("details")?.removeAttribute("open");
            }}
          >
            Cancel
          </button>
          <button type="submit" className={BUTTON}>
            Create {label.toLowerCase()}
          </button>
        </div>
      </form>
    </details>
  );
}

/**
 * The talks that never touch the form. Paste what arrived; everything else is
 * optional, and the panel says out loud that nothing is sent — an organizer
 * pasting a stranger's email into a tool with a mailer needs that in writing,
 * not in the release notes.
 */
function CaptureDrawer({
  tab,
  trackId,
  tracks: trackOptions,
}: {
  tab: SessionStatus;
  trackId: string | null;
  tracks: { id: string; name: string }[];
}) {
  return (
    <details className="relative" data-testid="capture-drawer">
      <summary className={`${GHOST_BUTTON} cursor-pointer list-none`}>+ Capture pitch</summary>
      <form
        method="post"
        className="absolute right-0 z-10 mt-2 w-80 space-y-3 rounded-lg border border-gray-200 bg-white p-4 shadow-lg dark:border-gray-700 dark:bg-gray-900"
      >
        <input type="hidden" name="intent" value="capture-on-behalf" />
        <input type="hidden" name="tab" value={tab} />
        {trackId ? <input type="hidden" name="track" value={trackId} /> : null}

        <p className="text-sm font-semibold">Capture on their behalf</p>
        <p className="text-xs text-gray-500">
          A pitch that arrived by email, DM or in a hallway. Paste what you got — every field
          is optional. Nothing is sent to the speaker.
        </p>

        <label className="block text-sm">
          What they sent you
          <textarea name="pasted" rows={5} className={FIELD} />
        </label>

        <label className="block text-sm">
          Where it came from
          <select name="source" defaultValue="email" className={FIELD}>
            {CAPTURE_SOURCES.map((source) => (
              <option key={source} value={source}>
                {CAPTURE_SOURCE_LABELS[source]}
              </option>
            ))}
          </select>
        </label>

        <label className="block text-sm">
          Title
          <input name="title" maxLength={255} className={FIELD} />
        </label>

        <label className="block text-sm">
          Speaker email
          <input name="speakerEmail" type="email" className={FIELD} />
        </label>

        <label className="block text-sm">
          Speaker name
          <input name="speakerName" maxLength={255} className={FIELD} />
        </label>

        <label className="block text-sm">
          Track
          <select name="trackId" className={FIELD} defaultValue="">
            <option value="">No track</option>
            {trackOptions.map((track) => (
              <option key={track.id} value={track.id}>
                {track.name}
              </option>
            ))}
          </select>
        </label>

        <div className="flex justify-end gap-2">
          <button
            type="reset"
            className={GHOST_BUTTON}
            onClick={(event) => {
              event.currentTarget.closest("details")?.removeAttribute("open");
            }}
          >
            Cancel
          </button>
          <button type="submit" className={BUTTON}>
            Capture
          </button>
        </div>
      </form>
    </details>
  );
}

export type AbstractsViewProps = Omit<
  Awaited<ReturnType<typeof loader>>,
  "sort" | "aiAvailable" | "notifyFailed"
> & {
  sort?: SubmissionScoreSort | null;
  /** Optional so hand-built render-test props stay short. */
  aiAvailable?: boolean;
  /** Optional so hand-built render-test props stay short. */
  notifyFailed?: number;
  actionData?: { ok: false; error: string } | undefined;
};

export function AbstractsView({
  event,
  tab,
  trackId,
  sort = null,
  tabs,
  rows,
  tracks: trackOptions,
  formats: formatOptions,
  rooms: roomOptions,
  queue,
  notice,
  notifyFailed = 0,
  confirming,
  aiAvailable = false,
  actionData,
}: AbstractsViewProps) {
  if (!event) {
    return (
      <LaneStub lane="No event yet">
        Once an event is set up, every abstract submitted to it lands here for review.
      </LaneStub>
    );
  }

  const queueTotal = queue.accept + queue.decline;
  const nextScoreSort = sort === "score-desc" ? "score-asc" : sort === "score-asc" ? null : "score-desc";

  return (
    <div className="space-y-4">
      <PageHeader
        title="Abstracts"
        description="Everything submitted to this event, in the queue it is waiting in. Move a proposal by opening it, or commit the staged decisions in one pass."
        actions={
          <>
          <a href="/admin/submissions/scores.csv" download className={GHOST_BUTTON}>
            Export scores (CSV)
          </a>
          {/* Advisory first pass over the Pending tab. Capped and sequential —
              see AI_TRIAGE_BULK_CAP — and it never moves a status. */}
          {aiAvailable ? (
            <form method="post">
              <input type="hidden" name="intent" value="run-ai-triage-bulk" />
              <input type="hidden" name="tab" value={tab} />
              {trackId ? <input type="hidden" name="track" value={trackId} /> : null}
              <button
                type="submit"
                data-testid="bulk-ai-triage"
                className={GHOST_BUTTON}
                title={`Scores up to ${AI_TRIAGE_BULK_CAP} pending abstracts that have no AI first pass yet. Advisory only.`}
              >
                Run AI triage on pending
              </button>
            </form>
          ) : (
            <span
              data-testid="bulk-ai-triage-unavailable"
              className="self-center text-xs text-gray-500"
            >
              AI triage unavailable in this deployment
            </span>
          )}
          <AddRecordDrawer
            kind="abstract"
            tab={tab}
            trackId={trackId}
            tracks={trackOptions}
            formats={formatOptions}
            rooms={roomOptions}
          />
          <AddRecordDrawer
            kind="session"
            tab={tab}
            trackId={trackId}
            tracks={trackOptions}
            formats={formatOptions}
            rooms={roomOptions}
          />
          <CaptureDrawer tab={tab} trackId={trackId} tracks={trackOptions} />
          {/* Committing is the irreversible moment in this screen: it composes
              program sessions and emails speakers. So the button on the toolbar
              only NAVIGATES to a confirmation; the POST lives behind it. */}
          {queueTotal === 0 ? (
            <button type="button" className={BUTTON} disabled>
              Commit queues ({queue.accept} accept / {queue.decline} decline)
            </button>
          ) : (
            <a
              href={listUrl(tab, trackId, "&confirm=commit", sort)}
              data-testid="commit-queues"
              className={BUTTON}
            >
              Commit queues ({queue.accept} accept / {queue.decline} decline)
            </a>
          )}
          </>
        }
      />

      {confirming && queueTotal > 0 ? (
        <section
          data-testid="commit-confirm"
          className="rounded-lg border border-amber-300 bg-amber-50 p-4 dark:border-amber-800 dark:bg-amber-950"
        >
          <h3 className="text-sm font-semibold">Commit {queueTotal} queued decisions?</h3>
          <ul className="mt-2 space-y-1 text-sm">
            <li>
              <strong className="tabular-nums">{queue.accept}</strong>{" "}
              {queue.accept === 1 ? "abstract becomes" : "abstracts become"}{" "}
              <strong>Accepted</strong> — each one composes a program session and creates
              that speaker&rsquo;s portal tasks.
            </li>
            <li>
              <strong className="tabular-nums">{queue.decline}</strong>{" "}
              {queue.decline === 1 ? "abstract becomes" : "abstracts become"}{" "}
              <strong>Declined</strong>.
            </li>
            <li className="text-gray-600 dark:text-gray-300">
              Everything in Pending, Accepted, Declined and Withdrawn is left alone.
            </li>
          </ul>
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <form method="post">
              <input type="hidden" name="intent" value="commit-queues" />
              <input type="hidden" name="tab" value={tab} />
              {trackId ? <input type="hidden" name="track" value={trackId} /> : null}
              <button type="submit" data-testid="commit-confirm-submit" className={BUTTON}>
                Yes, commit {queueTotal} decision{queueTotal === 1 ? "" : "s"}
              </button>
            </form>
            <a href={listUrl(tab, trackId, "", sort)} className={`text-sm ${linkClass}`}>
              Cancel
            </a>
          </div>
        </section>
      ) : null}

      {notice ? (
        <div className="rounded border border-green-300 bg-green-50 p-3 text-sm dark:border-green-800 dark:bg-green-950">
          <p>{notice}</p>
          {notifyFailed > 0 ? (
            <form method="post" action="/admin/agenda" className="mt-2">
              <input type="hidden" name="intent" value="send-decision-letters" />
              <input type="hidden" name="view" value="list" />
              <button type="submit" className={GHOST_BUTTON}>
                Retry failed decision letters
              </button>
            </form>
          ) : null}
        </div>
      ) : null}
      {actionData && !actionData.ok ? (
        <p className="rounded border border-red-300 bg-red-50 p-3 text-sm text-red-700 dark:border-red-800 dark:bg-red-950 dark:text-red-200">
          {actionData.error}
        </p>
      ) : null}

      <nav className="flex flex-wrap gap-1 border-b border-gray-200 pb-2 dark:border-gray-800">
        {tabs.map((entry) => (
          <a
            key={entry.status}
            href={listUrl(entry.status, trackId, "", sort)}
            aria-current={entry.status === tab ? "page" : undefined}
            /*
             * The same active treatment the organizer nav now carries — deeper
             * fill, heavier weight, a solid bottom edge — so "which queue am I
             * looking at" is answered the same way in both strips. ⚠️ The label
             * and count stay ONE space apart: `seeded-demo.spec` and
             * `mobile-organizer.spec` match this link by the accessible name
             * `/^Accepted \d+$/`, so a separator between them breaks the walk.
             */
            className={[
              "rounded-lg px-3 py-1.5 text-sm whitespace-nowrap transition-colors",
              entry.status === tab
                ? "bg-blue-100 font-semibold text-blue-800 shadow-[inset_0_-2px_0_0_var(--color-blue-600)] dark:bg-blue-950 dark:text-blue-100 dark:shadow-[inset_0_-2px_0_0_var(--color-blue-400)]"
                : "font-medium text-gray-500 hover:bg-gray-100 hover:text-gray-900 dark:text-gray-400 dark:hover:bg-gray-800 dark:hover:text-gray-100",
            ].join(" ")}
          >
            {entry.label} <span className="font-semibold tabular-nums">{entry.count}</span>
          </a>
        ))}
      </nav>

      <form method="get" className="flex flex-wrap items-end gap-2">
        <input type="hidden" name="tab" value={tab} />
        {sort ? <input type="hidden" name="sort" value={sort} /> : null}
        <label className="text-sm">
          <span className="mr-2">Track</span>
          <select name="track" defaultValue={trackId ?? ""} className="rounded border border-gray-300 px-2 py-1.5 text-sm dark:border-gray-700 dark:bg-gray-900">
            <option value="">All tracks</option>
            {trackOptions.map((track) => (
              <option key={track.id} value={track.id}>
                {track.name}
              </option>
            ))}
          </select>
        </label>
        <button type="submit" className={GHOST_BUTTON}>
          Apply filter
        </button>
        {trackId ? (
          <a href={listUrl(tab, null, "", sort)} className={`text-sm ${linkClass}`}>
            Clear
          </a>
        ) : null}
      </form>

      <div className="overflow-x-auto rounded-xl border border-gray-200 bg-white shadow-card dark:border-gray-800 dark:bg-gray-900">
        <table className="w-full min-w-3xl text-left text-sm">
          {/*
            * `py-2.5` on the head and `bg-gray-50` behind it: an eyebrow-sized
            * label row with the same padding as the data rows sat ON the first
            * abstract with nothing to separate them.
            */}
          <thead
            className={`border-b border-gray-200 bg-gray-50 ${eyebrowClass} dark:border-gray-800 dark:bg-gray-950/60`}
          >
            <tr>
              <th className="py-2.5 pr-3 pl-4 font-semibold whitespace-nowrap">ID</th>
              <th className="py-2.5 pr-3 font-medium">Title</th>
              <th className="py-2.5 pr-3 font-medium">Speaker</th>
              <th className="py-2.5 pr-3 font-medium">Track</th>
              <th className="py-2.5 pr-3 font-medium">Source</th>
              <th className="py-2.5 pr-3 font-medium whitespace-nowrap">Submitted</th>
              <th
                className="py-2.5 pr-3 font-medium"
                aria-sort={sort === "score-desc" ? "descending" : sort === "score-asc" ? "ascending" : "none"}
              >
                <a href={listUrl(tab, trackId, "", nextScoreSort)} className={linkClass}>
                  Score
                </a>
              </th>
              <th className="py-2 pr-3 font-medium">Status</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
            {rows.length === 0 ? (
              <tr>
                <td colSpan={8} className="py-8 text-center text-gray-500">
                  No abstracts in {tabFor(tab).label}
                  {trackId ? " for this track" : ""} yet.
                </td>
              </tr>
            ) : (
              rows.map((row) => (
                <tr
                  key={row.id}
                  className="hover:bg-gray-50 dark:hover:bg-gray-900/50"
                >
                  {/*
                    * `whitespace-nowrap`. The ID column was sized by its
                    * two-character header, so every single row broke `ABS-20`
                    * after the hyphen and printed a two-line identifier — the
                    * most visible defect on the busiest organizer table, on all
                    * twelve rows at once.
                    */}
                  <td className="py-2.5 pr-3 pl-4 font-mono text-xs whitespace-nowrap tabular-nums text-gray-500 dark:text-gray-400">
                    {row.friendlyId ?? "—"}
                  </td>
                  <td className="py-2 pr-3">
                    {/* The drill-in. The tab/track filter rides along so the
                        detail page's prev/next walks the list you are looking at. */}
                    <a
                      className="font-medium text-gray-900 hover:text-blue-700 hover:underline dark:text-gray-100 dark:hover:text-blue-300"
                      href={detailUrl(row.id, tab, trackId)}
                    >
                      {row.title}
                    </a>
                  </td>
                  <td className="py-2 pr-3">
                    {row.speakerLinks.length
                      ? row.speakerLinks.map((speaker, index) => (
                          <span key={speaker.id}>
                            {index > 0 ? ", " : ""}
                            <a
                              className="font-medium text-gray-900 hover:text-blue-700 hover:underline dark:text-gray-100 dark:hover:text-blue-300"
                              href={`/admin/speakers/${speaker.id}`}
                            >
                              {speaker.name}
                            </a>
                          </span>
                        ))
                      : "—"}
                  </td>
                  <td className="py-2 pr-3">
                    {row.trackName ? (
                      <TrackChip name={row.trackName} color={row.trackColor} />
                    ) : (
                      "—"
                    )}
                  </td>
                  {/*
                    * `whitespace-nowrap`, inside a table that already owns its
                    * own `overflow-x-auto`. "Call for Proposals 2026" wrapped on
                    * every single row, so the least interesting column — the
                    * same value twelve times — was also the tallest thing in
                    * each row. A long form name widens the scroller instead.
                    */}
                  <td className="py-2.5 pr-3 whitespace-nowrap text-gray-500 dark:text-gray-400">
                    {row.source}
                  </td>
                  <td className="py-2.5 pr-3 whitespace-nowrap tabular-nums text-gray-500 dark:text-gray-400">
                    {formatDate(row.submittedAt, event.timezone)}
                  </td>
                  <td
                    className="py-2 pr-3 align-top tabular-nums"
                    data-testid={`aggregate-score-${row.id}`}
                  >
                    {row.aggregateScore === null && row.reviewCount === 0 ? (
                      "—"
                    ) : (
                      <>
                        {/*
                         * An em dash HERE means "reviewed, no number" — a round
                         * whose rubric cannot produce one. Without the count
                         * beneath it, that cell was byte-identical to a
                         * submission nobody had opened.
                         */}
                        <div className="font-medium text-gray-900 dark:text-gray-100">
                          {row.aggregateScore === null ? "—" : row.aggregateScore.toFixed(2)}
                        </div>
                        <div className="text-xs text-gray-500">
                          {row.reviewCount} review{row.reviewCount === 1 ? "" : "s"}
                        </div>
                      </>
                    )}
                  </td>
                  <td className="py-2 pr-3 align-top">
                    <StatusCell
                      sessionId={row.id}
                      status={row.status}
                      tab={tab}
                      trackId={trackId}
                    />
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <p className="text-xs text-gray-500">
        {rows.length} row{rows.length === 1 ? "" : "s"} in {tabFor(tab).label}. Committing the
        queues moves Accept Queue → Accepted (composing a program session and creating portal
        tasks) and Decline Queue → Declined. Everything else is left alone.
      </p>
    </div>
  );
}

export default function AdminSubmissions({ loaderData, actionData }: Route.ComponentProps) {
  return <AbstractsView {...loaderData} actionData={actionData ?? undefined} />;
}
