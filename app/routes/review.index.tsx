import { and, asc, count, desc, eq, gt, inArray, isNull, lte, or } from "drizzle-orm";
import { redirect } from "react-router";

import { buttonClass, StatusPill } from "~/components/portal-ui";
import { LaneStub } from "~/components/shell";
import { getDb } from "~/db/client.server";
import {
  people,
  reviewAssignments,
  reviewRounds,
  reviews,
  reviewTeamMembers,
  reviewTeams,
  sessionParticipants,
  sessions,
  tracks,
} from "~/db/schema";
import { textOf } from "~/lib/form-schema";
import { requireReviewerActor, requireReviewerEvent } from "~/lib/review/access.server";
import {
  isRoundBlind,
  isSelectCriterion,
  parseRubric,
  scoreRubric,
} from "~/lib/review/scoring";
import type { Route } from "./+types/review.index";

const CARD = "rounded-xl border border-gray-200 bg-white p-4 shadow-sm dark:border-gray-800 dark:bg-gray-900";
const INPUT = "rounded border border-gray-300 px-2 py-1.5 dark:border-gray-700 dark:bg-gray-950";

function abstractText(answers: unknown, fallback: string | null): string {
  const bag = answers && typeof answers === "object" ? (answers as Record<string, unknown>) : {};
  const fields = bag.fields && typeof bag.fields === "object"
    ? (bag.fields as Record<string, unknown>)
    : bag;
  return textOf(fields.abstract as never).trim() || fallback || "";
}

function reviewAnchor(roundId: string, sessionId: string): string {
  return `review-${roundId}-${sessionId}`;
}

function savedAtLabel(iso: string): string {
  return new Date(iso).toISOString().replace("T", " ").slice(0, 16) + " UTC";
}

export async function loader({ request }: Route.LoaderArgs) {
  const actor = await requireReviewerActor(request);
  const event = await requireReviewerEvent(request, actor.person.id);
  const now = new Date();
  const db = getDb();

  const assigned = await db
    .select({
      round: reviewRounds,
      session: sessions,
      teamName: reviewTeams.name,
      trackName: tracks.name,
      review: reviews,
    })
    .from(reviewAssignments)
    .innerJoin(reviewRounds, eq(reviewRounds.id, reviewAssignments.roundId))
    .innerJoin(reviewTeams, eq(reviewTeams.id, reviewAssignments.teamId))
    .innerJoin(
      reviewTeamMembers,
      and(
        eq(reviewTeamMembers.teamId, reviewAssignments.teamId),
        eq(reviewTeamMembers.personId, actor.person.id),
      ),
    )
    .innerJoin(sessions, eq(sessions.id, reviewAssignments.sessionId))
    .leftJoin(tracks, eq(tracks.id, sessions.trackId))
    .leftJoin(
      reviews,
      and(
        eq(reviews.roundId, reviewAssignments.roundId),
        eq(reviews.sessionId, reviewAssignments.sessionId),
        eq(reviews.reviewerId, actor.person.id),
      ),
    )
    .where(
      and(
        eq(reviewRounds.eventId, event.id),
        eq(reviewTeams.eventId, event.id),
        eq(sessions.eventId, event.id),
        eq(sessions.isAbstract, true),
        isNull(sessions.deletedAt),
        or(isNull(reviewRounds.opensAt), lte(reviewRounds.opensAt, now)),
        or(isNull(reviewRounds.closesAt), gt(reviewRounds.closesAt, now)),
        isNull(reviews.recusedAt),
      ),
    )
    .orderBy(asc(reviewRounds.ordinal), desc(sessions.createdAt));

  const grouped = new Map<string, (typeof assigned)[number] & { teamNames: string[] }>();
  for (const row of assigned) {
    const key = `${row.round.id}:${row.session.id}`;
    const existing = grouped.get(key);
    if (existing) {
      if (!existing.teamNames.includes(row.teamName)) existing.teamNames.push(row.teamName);
    } else {
      grouped.set(key, { ...row, teamNames: [row.teamName] });
    }
  }

  const groupedRows = [...grouped.values()].map((row) => ({
    ...row,
    blind: isRoundBlind(row.round.rubric),
  }));
  const unblindedSessionIds = Array.from(
    new Set(groupedRows.filter((row) => !row.blind).map((row) => row.session.id)),
  );
  const blindedSessionIds = Array.from(
    new Set(groupedRows.filter((row) => row.blind).map((row) => row.session.id)),
  );

  const speakerRows = unblindedSessionIds.length
    ? await db
        .select({
          sessionId: sessionParticipants.sessionId,
          name: people.fullName,
          company: people.company,
          title: people.title,
        })
        .from(sessionParticipants)
        .innerJoin(people, eq(people.id, sessionParticipants.personId))
        .where(inArray(sessionParticipants.sessionId, unblindedSessionIds))
        .orderBy(desc(sessionParticipants.isPrimary), asc(sessionParticipants.order))
    : [];
  const blindedCountRows = blindedSessionIds.length
    ? await db
        .select({
          sessionId: sessionParticipants.sessionId,
          speakerCount: count(),
        })
        .from(sessionParticipants)
        .where(inArray(sessionParticipants.sessionId, blindedSessionIds))
        .groupBy(sessionParticipants.sessionId)
    : [];
  const speakersBySession = new Map<string, typeof speakerRows>();
  for (const speaker of speakerRows) {
    const speakers = speakersBySession.get(speaker.sessionId) ?? [];
    speakers.push(speaker);
    speakersBySession.set(speaker.sessionId, speakers);
  }
  const blindedCounts = new Map(
    blindedCountRows.map((row) => [row.sessionId, Number(row.speakerCount)]),
  );

  return {
    event: { id: event.id, name: event.name, slug: event.slug },
    person: { email: actor.person.email, fullName: actor.person.fullName },
    impersonatedBy: actor.impersonatedBy
      ? { email: actor.impersonatedBy.email, fullName: actor.impersonatedBy.fullName }
      : null,
    assignments: groupedRows.map((row) => {
      const sessionSpeakers = row.blind ? [] : (speakersBySession.get(row.session.id) ?? []);
      return {
        roundId: row.round.id,
        roundName: row.round.name,
        roundOrdinal: row.round.ordinal,
        rubric: parseRubric(row.round.rubric),
        blind: row.blind,
        speakers: sessionSpeakers.map(({ name, company, title }) => ({
          name,
          company,
          title,
        })),
        speakerCount: row.blind
          ? (blindedCounts.get(row.session.id) ?? 0)
          : sessionSpeakers.length,
        sessionId: row.session.id,
        friendlyId: row.session.friendlyId,
        title: row.session.title,
        abstract: abstractText(row.session.answers, row.session.description),
        trackName: row.trackName,
        teamNames: row.teamNames,
        review: row.review
          ? {
              scores: row.review.scores ?? {},
              totalScore: row.review.totalScore ?? 0,
              comment: row.review.comment ?? "",
              submittedAt: row.review.submittedAt?.toISOString() ?? null,
            }
          : null,
      };
    }),
  };
}

export async function action({ request }: Route.ActionArgs) {
  const actor = await requireReviewerActor(request);
  const event = await requireReviewerEvent(request, actor.person.id);
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  if (intent !== "save-review" && intent !== "declare-conflict") {
    return { ok: false as const, error: "Unknown reviewer action." };
  }

  const roundId = String(form.get("roundId") ?? "");
  const sessionId = String(form.get("sessionId") ?? "");
  const now = new Date();
  const [scope] = await getDb()
    .select({ round: reviewRounds })
    .from(reviewAssignments)
    .innerJoin(reviewRounds, eq(reviewRounds.id, reviewAssignments.roundId))
    .innerJoin(reviewTeams, eq(reviewTeams.id, reviewAssignments.teamId))
    .innerJoin(
      reviewTeamMembers,
      and(
        eq(reviewTeamMembers.teamId, reviewAssignments.teamId),
        eq(reviewTeamMembers.personId, actor.person.id),
      ),
    )
    .innerJoin(sessions, eq(sessions.id, reviewAssignments.sessionId))
    .where(
      and(
        eq(reviewAssignments.roundId, roundId),
        eq(reviewAssignments.sessionId, sessionId),
        eq(reviewRounds.eventId, event.id),
        eq(reviewTeams.eventId, event.id),
        eq(sessions.eventId, event.id),
        eq(sessions.isAbstract, true),
        isNull(sessions.deletedAt),
        or(isNull(reviewRounds.opensAt), lte(reviewRounds.opensAt, now)),
        or(isNull(reviewRounds.closesAt), gt(reviewRounds.closesAt, now)),
      ),
    )
    .limit(1);
  if (!scope) {
    return { ok: false as const, error: "That abstract is not assigned to you in an open round." };
  }

  if (intent === "declare-conflict") {
    await getDb()
      .insert(reviews)
      .values({
        id: crypto.randomUUID(),
        roundId,
        sessionId,
        reviewerId: actor.person.id,
        recusedAt: now,
        scores: null,
        totalScore: null,
        submittedAt: null,
      })
      .onConflictDoUpdate({
        target: [reviews.roundId, reviews.sessionId, reviews.reviewerId],
        set: {
          recusedAt: now,
          scores: null,
          totalScore: null,
          submittedAt: null,
          updatedAt: now,
        },
      });
    return redirect(`/review?event=${encodeURIComponent(event.slug)}`);
  }

  const existing = await getDb().query.reviews.findFirst({
    columns: { recusedAt: true },
    where: and(
      eq(reviews.roundId, roundId),
      eq(reviews.sessionId, sessionId),
      eq(reviews.reviewerId, actor.person.id),
    ),
  });
  if (existing?.recusedAt) {
    return { ok: false as const, error: "You declared a conflict on this abstract." };
  }

  const rubric = parseRubric(scope.round.rubric);
  const submitted = Object.fromEntries(
    rubric.criteria.map((criterion) => [criterion.key, form.get(`score-${criterion.key}`)]),
  );
  const scored = scoreRubric(rubric, submitted);
  if (!scored.ok) return { ok: false as const, error: scored.error };

  const comment = String(form.get("comment") ?? "").trim() || null;
  await getDb()
    .insert(reviews)
    .values({
      id: crypto.randomUUID(),
      roundId,
      sessionId,
      reviewerId: actor.person.id,
      scores: scored.scores,
      totalScore: scored.totalScore,
      comment,
      submittedAt: now,
    })
    .onConflictDoUpdate({
      target: [reviews.roundId, reviews.sessionId, reviews.reviewerId],
      set: {
        scores: scored.scores,
        totalScore: scored.totalScore,
        comment,
        submittedAt: now,
        updatedAt: now,
      },
    });

  return redirect(`/review?event=${encodeURIComponent(event.slug)}#${reviewAnchor(roundId, sessionId)}`);
}

function Scorecard({
  assignment,
}: {
  assignment: Awaited<ReturnType<typeof loader>>["assignments"][number];
}) {
  // Select criteria contribute 0 by design.
  const maxScore = assignment.rubric.criteria.reduce(
    (sum, criterion) => sum + criterion.max * criterion.weight,
    0,
  );
  return (
    <article
      id={reviewAnchor(assignment.roundId, assignment.sessionId)}
      className={CARD}
      data-testid="reviewer-assignment"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-xs font-medium tracking-wide text-blue-700 uppercase dark:text-blue-300">
            Round {assignment.roundOrdinal} · {assignment.roundName}
          </p>
          <h2 className="mt-1 text-lg font-semibold">{assignment.title}</h2>
          <p className="mt-1 text-xs text-gray-500">
            {assignment.friendlyId ?? "Unnumbered"}
            {assignment.trackName ? ` · ${assignment.trackName}` : ""}
            {` · ${assignment.teamNames.join(", ")}`}
          </p>
          {assignment.blind ? (
            <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-gray-500">
              <StatusPill tone="neutral">Blind review</StatusPill>
              <span>Speaker identity is hidden for this round.</span>
              {assignment.speakerCount > 1 ? <span>{assignment.speakerCount} speakers</span> : null}
            </div>
          ) : assignment.speakers.length > 0 ? (
            <div className="mt-2 space-y-1">
              {assignment.speakers.map((speaker, index) => (
                <div key={index} data-testid="reviewer-speaker">
                  <p className="text-sm" data-testid="reviewer-speaker-name">
                    {[speaker.name, speaker.company].filter(Boolean).join(" · ")}
                  </p>
                  {speaker.title ? <p className="text-xs text-gray-500">{speaker.title}</p> : null}
                </div>
              ))}
            </div>
          ) : null}
        </div>
        <span className="rounded-full bg-gray-100 px-2.5 py-1 text-xs tabular-nums dark:bg-gray-800">
          {assignment.review ? `${assignment.review.totalScore} / ${maxScore}` : `Not scored · 0 / ${maxScore}`}
        </span>
      </div>

      <div className="mt-4 border-l-2 border-gray-200 pl-3 text-sm leading-relaxed whitespace-pre-line dark:border-gray-700">
        {assignment.abstract || "No abstract text was supplied."}
      </div>

      <form method="post" className="mt-5 space-y-3" data-testid="reviewer-scorecard">
        <input type="hidden" name="intent" value="save-review" />
        <input type="hidden" name="roundId" value={assignment.roundId} />
        <input type="hidden" name="sessionId" value={assignment.sessionId} />
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {assignment.rubric.criteria.map((criterion) => {
            const isSelect = isSelectCriterion(criterion);
            return (
              <label key={criterion.key} className="grid gap-1 text-sm">
                <span>
                  {criterion.label}
                  {!isSelect && criterion.weight !== 1 ? <span className="ml-1 text-xs text-gray-500">×{criterion.weight}</span> : null}
                </span>
                {isSelect ? (
                  <select
                    className={INPUT}
                    name={`score-${criterion.key}`}
                    required
                    defaultValue={typeof assignment.review?.scores[criterion.key] === "string" ? String(assignment.review.scores[criterion.key]) : ""}
                    data-testid="reviewer-choice"
                  >
                    <option value="">Select…</option>
                    {(criterion.options ?? []).map((option) => (
                      <option key={option} value={option}>{option}</option>
                    ))}
                  </select>
                ) : (
                  <input
                    className={INPUT}
                    type="number"
                    name={`score-${criterion.key}`}
                    min={criterion.min}
                    max={criterion.max}
                    step="any"
                    required
                    defaultValue={assignment.review?.scores[criterion.key]}
                  />
                )}
              </label>
            );
          })}
        </div>
        <label className="grid gap-1 text-sm">
          Private reviewer note
          <textarea className={INPUT} name="comment" rows={3} defaultValue={assignment.review?.comment} />
        </label>
        <button className={buttonClass("primary")} type="submit">
          {assignment.review ? "Update score" : "Submit score"}
        </button>
        {assignment.review?.submittedAt ? (
          <span className="ml-3 text-xs text-gray-500">Saved {savedAtLabel(assignment.review.submittedAt)}</span>
        ) : null}
      </form>
      <form method="post" className="mt-4 border-t border-gray-200 pt-4 dark:border-gray-700">
        <input type="hidden" name="intent" value="declare-conflict" />
        <input type="hidden" name="roundId" value={assignment.roundId} />
        <input type="hidden" name="sessionId" value={assignment.sessionId} />
        <p className="mb-2 text-xs text-gray-500">
          Removes this abstract from your queue and tells the organizer why.
        </p>
        <button className={buttonClass("secondary")} type="submit">Declare conflict</button>
      </form>
    </article>
  );
}

export function ReviewerWorkspaceView({
  loaderData,
  actionData,
}: Pick<Route.ComponentProps, "loaderData" | "actionData">) {
  const displayName = loaderData.person.fullName ?? loaderData.person.email;
  return (
    <div className="min-h-screen bg-gray-50 text-gray-900 dark:bg-gray-950 dark:text-gray-100">
      {loaderData.impersonatedBy ? (
        <div className="bg-amber-400 text-amber-950">
          <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-2 px-4 py-2 text-sm">
            <strong>Viewing reviewer workspace as {displayName}</strong>
            <form method="post" action="/review/impersonate/stop">
              <button className="rounded bg-amber-950 px-3 py-1.5 text-xs font-semibold text-white" type="submit">
                Back to organizer
              </button>
            </form>
          </div>
        </div>
      ) : null}
      <header className="border-b border-gray-200 bg-white dark:border-gray-800 dark:bg-gray-900">
        <div className="mx-auto flex max-w-5xl items-center justify-between gap-3 px-4 py-4">
          <div>
            <p className="text-lg font-semibold">callboard <span className="font-normal text-gray-500">/ Review</span></p>
            <p className="text-sm text-gray-500">{loaderData.event.name} · Assigned abstracts only</p>
          </div>
          <div className="flex items-center gap-3 text-sm">
            <span className="hidden text-gray-500 sm:inline">{displayName}</span>
            <form method="post" action="/logout">
              <button type="submit" className="underline underline-offset-2">Sign out</button>
            </form>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-5xl px-4 py-6">
        {actionData && !actionData.ok ? (
          <p role="alert" className="mb-4 rounded border border-red-300 bg-red-50 p-3 text-sm text-red-700 dark:border-red-800 dark:bg-red-950 dark:text-red-200">
            {actionData.error}
          </p>
        ) : null}
        {loaderData.assignments.length === 0 ? (
          <LaneStub lane="No open assignments">
            You belong to a review team for this event, but nothing is assigned to you in an open round yet.
          </LaneStub>
        ) : (
          <div className="grid gap-5">
            {loaderData.assignments.map((assignment) => (
              <Scorecard key={`${assignment.roundId}:${assignment.sessionId}`} assignment={assignment} />
            ))}
          </div>
        )}
      </main>
    </div>
  );
}

export default ReviewerWorkspaceView;
