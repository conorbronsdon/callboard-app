/**
 * Programme-session drill-in for organizer-owned content and speaker changes.
 *
 * DECISIONS.md #3 keeps an accepted abstract and its composed programme row in
 * sync, while schedule placement, publication, and decision state remain on
 * their dedicated admin paths. The markup is router-free for resilient SSR.
 */
import { and, asc, eq, isNull } from "drizzle-orm";
import { redirect } from "react-router";

import { buttonClass } from "~/components/portal-ui";
import {
  RevisionHistory,
  toRevisionEntries,
  type RevisionEntry,
} from "~/components/revision-history";
import { linkClass } from "~/components/shell";
import { getDb } from "~/db/client.server";
import {
  eventPeople,
  PARTICIPANT_ROLES,
  people,
  rooms,
  sessionParticipants,
  sessions,
  tracks,
  type ParticipantRole,
  type SessionStatus,
} from "~/db/schema";
import {
  addSessionParticipant,
  PARTICIPANT_ROLE_LABELS,
  removeSessionParticipant,
} from "~/lib/admin/session-participants.server";
import { updateSessionContent } from "~/lib/admin/session-edit.server";
import {
  listSessionRevisions,
  restoreSessionRevision,
} from "~/lib/admin/session-revisions.server";
import { conflictLabel } from "~/lib/agenda/conflicts";
import { conflictsInvolving, loadProgramme } from "~/lib/agenda/programme.server";
import { requireAdmin } from "~/lib/auth/auth.server";
import { currentEvent } from "~/lib/event.server";
import type { Route } from "./+types/admin.session";

export interface SessionParticipantRow {
  personId: string;
  name: string;
  email: string;
  role: ParticipantRole;
  roleLabel: string;
  isPrimary: boolean;
}

export interface CandidateRow {
  personId: string;
  name: string;
  email: string;
}

export interface SessionData {
  event: { id: string; name: string; slug: string } | null;
  session: {
    id: string;
    friendlyId: string | null;
    title: string;
    abstract: string;
    status: SessionStatus;
    roomName: string | null;
    trackName: string | null;
    startsAt: number | null;
    endsAt: number | null;
    isPublic: boolean;
    publicHref: string | null;
  } | null;
  participants: SessionParticipantRow[];
  candidates: CandidateRow[];
  source: { id: string; friendlyId: string | null } | null;
  conflicts: string[];
  roles: { value: string; label: string }[];
  revisions: RevisionEntry[];
  notice: string | null;
}

const roles = PARTICIPANT_ROLES.map((value) => ({
  value,
  label: PARTICIPANT_ROLE_LABELS[value],
}));

function emptyData(
  event: SessionData["event"],
  notice: string | null = null,
): SessionData {
  return {
    event,
    session: null,
    participants: [],
    candidates: [],
    source: null,
    conflicts: [],
    roles,
    revisions: [],
    notice,
  };
}

export function meta() {
  return [{ title: "Session — callboard admin" }];
}

export async function loader({ request, params }: Route.LoaderArgs): Promise<SessionData> {
  await requireAdmin(request);
  const event = await currentEvent(request);
  if (!event) return emptyData(null);

  const sessionId = params.id;
  const db = getDb();
  const [sessionRows, programme] = await Promise.all([
    db
      .select({
        id: sessions.id,
        friendlyId: sessions.friendlyId,
        title: sessions.title,
        description: sessions.description,
        status: sessions.status,
        roomName: rooms.name,
        trackName: tracks.name,
        startsAt: sessions.startsAt,
        endsAt: sessions.endsAt,
        isPublic: sessions.isPublic,
      })
      .from(sessions)
      .leftJoin(rooms, eq(rooms.id, sessions.roomId))
      .leftJoin(tracks, eq(tracks.id, sessions.trackId))
      .where(
        and(
          eq(sessions.id, sessionId),
          eq(sessions.eventId, event.id),
          eq(sessions.isAbstract, false),
          isNull(sessions.deletedAt),
        ),
      )
      .limit(1),
    loadProgramme(event.id),
  ]);
  const session = sessionRows[0];
  const eventData = { id: event.id, name: event.name, slug: event.slug };
  if (!session) return emptyData(eventData);

  const [participantRows, rosterRows, sourceRows, revisionRows] = await Promise.all([
    db
      .select({
        personId: people.id,
        name: people.fullName,
        email: people.email,
        role: sessionParticipants.role,
        isPrimary: sessionParticipants.isPrimary,
      })
      .from(sessionParticipants)
      .innerJoin(people, eq(people.id, sessionParticipants.personId))
      .where(eq(sessionParticipants.sessionId, sessionId))
      .orderBy(asc(sessionParticipants.order)),
    db
      .select({ personId: people.id, name: people.fullName, email: people.email })
      .from(eventPeople)
      .innerJoin(people, eq(people.id, eventPeople.personId))
      .where(eq(eventPeople.eventId, event.id))
      .orderBy(asc(people.fullName)),
    db
      .select({ id: sessions.id, friendlyId: sessions.friendlyId })
      .from(sessions)
      .where(
        and(
          eq(sessions.composedIntoSessionId, sessionId),
          eq(sessions.eventId, event.id),
          eq(sessions.isAbstract, true),
          isNull(sessions.deletedAt),
        ),
      )
      .limit(1),
    listSessionRevisions(sessionId, event.id),
  ]);

  const participants: SessionParticipantRow[] = participantRows.map((row) => ({
    personId: row.personId,
    name: row.name ?? row.email,
    email: row.email,
    role: row.role,
    roleLabel: PARTICIPANT_ROLE_LABELS[row.role],
    isPrimary: row.isPrimary,
  }));
  const participantIds = new Set(participants.map((row) => row.personId));
  const url = new URL(request.url);
  const saved = url.searchParams.get("saved");
  const added = url.searchParams.get("added");
  const removed = url.searchParams.get("removed");
  const restored = url.searchParams.get("restored");

  return {
    event: eventData,
    session: {
      id: session.id,
      friendlyId: session.friendlyId,
      title: session.title,
      abstract: session.description ?? "",
      status: session.status,
      roomName: session.roomName,
      trackName: session.trackName,
      startsAt: session.startsAt?.getTime() ?? null,
      endsAt: session.endsAt?.getTime() ?? null,
      isPublic: session.isPublic,
      publicHref: `/e/${event.slug}/schedule/${session.id}`,
    },
    participants,
    candidates: rosterRows
      .filter((row) => !participantIds.has(row.personId))
      .map((row) => ({
        personId: row.personId,
        name: row.name ?? row.email,
        email: row.email,
      })),
    source: sourceRows[0] ?? null,
    conflicts: conflictsInvolving(programme.conflicts, sessionId).map(conflictLabel),
    roles,
    revisions: toRevisionEntries(revisionRows),
    notice:
      restored === "1"
        ? "Restored an earlier version."
        : saved === "1"
        ? "Session details saved."
        : added
          ? `Added ${added} to this session.`
          : removed
            ? `Removed ${removed} from this session.`
            : null,
  };
}

async function personDisplayName(personId: string): Promise<string> {
  const db = getDb();
  const person = await db.query.people.findFirst({
    columns: { fullName: true, email: true },
    where: eq(people.id, personId),
  });
  return person?.fullName ?? person?.email ?? "Speaker";
}

export async function action({ request, params }: Route.ActionArgs) {
  const admin = await requireAdmin(request);
  const event = await currentEvent(request);
  if (!event) return { ok: false as const, error: "No event has been set up yet." };

  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "");
  const sessionId = params.id;
  const detailUrl = `/admin/sessions/${sessionId}`;

  if (intent === "restore-revision") {
    const result = await restoreSessionRevision({
      revisionId: String(formData.get("revisionId") ?? ""),
      sessionId,
      eventId: event.id,
      editor: {
        personId: admin.id,
        name: admin.fullName ?? admin.email,
      },
    });
    if (!result.ok) return { ok: false as const, error: result.error };
    return redirect(`${detailUrl}?restored=1`);
  }

  if (intent === "edit-session") {
    const result = await updateSessionContent({
      sessionId,
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
    return redirect(`${detailUrl}?saved=1`);
  }

  if (intent === "add-participant") {
    const personId = String(formData.get("personId") ?? "");
    const result = await addSessionParticipant({
      sessionId,
      eventId: event.id,
      personId,
      role: String(formData.get("role") ?? ""),
    });
    if (!result.ok) return { ok: false as const, error: result.error };

    const query = new URLSearchParams({ added: await personDisplayName(personId) });
    // Warn, never block: recompute AFTER the participant write so a newly
    // double-booked speaker is visible without undoing the organizer's choice.
    const after = await loadProgramme(event.id);
    if (conflictsInvolving(after.conflicts, sessionId).length > 0) {
      query.set("warn", "conflict");
    }
    return redirect(`${detailUrl}?${query.toString()}`);
  }

  if (intent === "remove-participant") {
    const personId = String(formData.get("personId") ?? "");
    const result = await removeSessionParticipant({
      sessionId,
      eventId: event.id,
      personId,
    });
    if (!result.ok) return { ok: false as const, error: result.error };
    const query = new URLSearchParams({ removed: await personDisplayName(personId) });
    return redirect(`${detailUrl}?${query.toString()}`);
  }

  return { ok: false as const, error: `Unknown intent "${intent}".` };
}

const FIELD =
  "rounded border border-gray-300 px-2 py-1 text-sm dark:border-gray-700 dark:bg-gray-900";
const BUTTON = buttonClass("primary");
const GHOST = buttonClass("secondary");
const PANEL = "rounded-lg border border-gray-200 p-4 dark:border-gray-800";

export function SessionScreen(data: SessionData) {
  if (!data.event) {
    return (
      <p className={PANEL}>No event yet — programme sessions belong to an event.</p>
    );
  }

  if (!data.session) {
    return (
      <div className={PANEL}>
        <p className="font-medium">That session no longer exists.</p>
        <a className={linkClass} href="/admin/agenda">
          Back to agenda
        </a>
      </div>
    );
  }

  const session = data.session;
  return (
    <div>
      <div className="mb-4 flex flex-wrap items-baseline gap-3">
        <div>
          <p className="font-mono text-xs text-gray-500">{session.friendlyId ?? "—"}</p>
          <h2 className="text-xl font-semibold">{session.title}</h2>
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-3">
          {session.isPublic && session.publicHref ? (
            <a className={linkClass} href={session.publicHref}>
              View on public schedule
            </a>
          ) : null}
          <a className={GHOST} href="/admin/agenda">
            Back to agenda
          </a>
        </div>
      </div>

      {data.notice ? (
        <p className="mb-3 rounded border border-gray-300 bg-gray-50 p-2 text-sm dark:border-gray-700 dark:bg-gray-900">
          {data.notice}
        </p>
      ) : null}

      {data.conflicts.length > 0 ? (
        <div
          data-session-conflict
          className="mb-3 rounded border border-amber-400 bg-amber-50 p-3 text-sm text-amber-900 dark:bg-amber-950 dark:text-amber-100"
        >
          <p className="font-semibold">This session has a scheduling conflict.</p>
          <ul className="mt-1 list-disc pl-5">
            {data.conflicts.map((conflict, index) => (
              <li key={`${conflict}-${index}`}>{conflict}</li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-2">
        <section className={PANEL}>
          <h3 className="mb-3 font-semibold">Details</h3>
          <form method="post" className="space-y-3" data-session-edit-form>
            <input type="hidden" name="intent" value="edit-session" />
            <label className="flex flex-col gap-1 text-xs">
              Title
              <input
                name="title"
                required
                maxLength={200}
                defaultValue={session.title}
                className={FIELD}
              />
            </label>
            <label className="flex flex-col gap-1 text-xs">
              Abstract
              <textarea
                name="abstract"
                rows={8}
                defaultValue={session.abstract}
                className={FIELD}
              />
            </label>
            <button type="submit" className={BUTTON}>
              Save details
            </button>
            {data.source ? (
              <p className="text-xs text-gray-500">
                Saved changes also update the speaker&apos;s accepted submission{" "}
                {data.source.friendlyId ?? data.source.id}. The public schedule reads the
                same row, so no extra sync is needed.
              </p>
            ) : null}
          </form>
        </section>

        <section className={PANEL}>
          <RevisionHistory entries={data.revisions} canRestore />
        </section>

        <section className={PANEL}>
          <h3 className="mb-3 font-semibold">Speakers</h3>
          {data.participants.length === 0 ? (
            <p className="mb-4 rounded border border-dashed border-gray-300 p-4 text-sm text-gray-500 dark:border-gray-700">
              No speakers are attached to this session yet. Speakers appear here when someone from
              the event roster is added to the session.
            </p>
          ) : (
            <ul className="mb-4 space-y-2">
              {data.participants.map((participant) => (
                <li
                  key={`${participant.personId}-${participant.role}`}
                  data-participant-row={participant.personId}
                  className="flex flex-wrap items-center gap-2 rounded border border-gray-200 p-3 dark:border-gray-800"
                >
                  <div>
                    <p className="font-medium">{participant.name}</p>
                    <p className="text-sm text-gray-500">{participant.email}</p>
                  </div>
                  <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs text-gray-700 dark:bg-gray-800 dark:text-gray-200">
                    {participant.roleLabel}
                  </span>
                  {participant.isPrimary ? (
                    <span className="rounded-full bg-blue-100 px-2 py-0.5 text-xs text-blue-800 dark:bg-blue-900 dark:text-blue-100">
                      Submitter
                    </span>
                  ) : null}
                  {participant.isPrimary ? (
                    <span className="ml-auto text-xs text-gray-500">Submitting speaker</span>
                  ) : (
                    <form method="post" className="ml-auto">
                      <input type="hidden" name="intent" value="remove-participant" />
                      <input type="hidden" name="personId" value={participant.personId} />
                      <button type="submit" className={GHOST}>
                        Remove
                      </button>
                    </form>
                  )}
                </li>
              ))}
            </ul>
          )}

          {data.candidates.length === 0 ? (
            <p className="rounded border border-dashed border-gray-300 p-4 text-sm text-gray-500 dark:border-gray-700">
              Everyone on this event&apos;s roster is already on this session. Add people
              from the{" "}
              <a className={linkClass} href="/admin/speakers">
                Speakers screen
              </a>{" "}
              first.
            </p>
          ) : (
            <form
              method="post"
              className="flex flex-wrap items-end gap-2"
              data-add-participant-form
            >
              <input type="hidden" name="intent" value="add-participant" />
              <label className="flex min-w-48 flex-1 flex-col gap-1 text-xs">
                Person
                <select name="personId" required className={FIELD}>
                  {data.candidates.map((candidate) => (
                    <option key={candidate.personId} value={candidate.personId}>
                      {candidate.name} — {candidate.email}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex flex-col gap-1 text-xs">
                Role
                <select name="role" defaultValue="speaker" className={FIELD}>
                  {data.roles.map((role) => (
                    <option key={role.value} value={role.value}>
                      {role.label}
                    </option>
                  ))}
                </select>
              </label>
              <button type="submit" className={BUTTON}>
                Add speaker
              </button>
            </form>
          )}
        </section>
      </div>
    </div>
  );
}

export default function AdminSession({ loaderData, actionData }: Route.ComponentProps) {
  const error = (actionData as { ok?: boolean; error?: string } | undefined)?.error;
  return (
    <>
      {error ? (
        <p className="mb-3 rounded border border-red-400 bg-red-50 p-2 text-sm text-red-800 dark:bg-red-950 dark:text-red-200">
          {error}
        </p>
      ) : null}
      <SessionScreen {...loaderData} />
    </>
  );
}
