/**
 * Tracks config — the metadata organizer content is grouped and routed by.
 *
 * Near-copy of admin.agenda.rooms.tsx (AIA-02): same loader/action shape, same
 * dup-name guard. Delete is NOT the rooms contract, because a track is
 * referenced from two places with two different mechanisms:
 *
 *   - `sessions.track_id` is a real FK with ON DELETE SET NULL, so programme
 *     sessions and CFP abstracts survive a delete — untracked, silently.
 *   - a form's `eligibleTrackIds` and `routing.defaultTrackId` are JSON
 *     (app/lib/form-schema.ts), NOT foreign keys. Nothing nulls them. The
 *     submit path checks the *configured* allowlist and then writes the id
 *     onto `sessions.track_id`, so a deleted-but-still-configured track is a
 *     dangling id on a live public form.
 *
 * So delete refuses while anything still points at the track, and names what
 * does. That is the read-side counterpart of the rule admin.forms.edit.tsx
 * already enforces on the write side (:640-648, :653-656) — same invariant,
 * other end of the lifecycle.
 *
 * A new track is usable immediately: the Track lane view and TrackPill in
 * admin.agenda.tsx, and the CFP eligible-tracks picker in
 * admin.forms.edit.tsx, all read live from the `tracks` table — no cache to
 * bust.
 *
 * Router-free markup for the same reasons as the agenda itself.
 */
import { and, asc, eq } from "drizzle-orm";
import { redirect } from "react-router";

import { buttonClass } from "~/components/portal-ui";
import { getDb } from "~/db/client.server";
import { forms, sessions, tracks } from "~/db/schema";
import { requireAdmin } from "~/lib/auth/auth.server";
import { currentEvent } from "~/lib/event.server";
import { parseFormSchema } from "~/lib/form-schema";
import type { Route } from "./+types/admin.agenda.tracks";

export interface TrackRow {
  id: string;
  name: string;
  color: string | null;
  /** How many programme sessions currently carry this track. */
  sessionCount: number;
  /** How many CFP abstracts currently carry it — the rows a delete would strand. */
  submissionCount: number;
}

interface TrackCounts {
  sessionCount: number;
  submissionCount: number;
}

type DbHandle = ReturnType<typeof getDb>;

/**
 * One query, two numbers, used by BOTH the count beside Delete and the refusal
 * that blocks it. Splitting them is how "0 sessions" came to render next to a
 * one-click Delete on a track holding forty submitted abstracts: the count
 * excluded abstracts and the delete never looked.
 */
async function trackCounts(
  db: DbHandle,
  eventId: string,
): Promise<Map<string, TrackCounts>> {
  const rows = await db
    .select({ trackId: sessions.trackId, isAbstract: sessions.isAbstract })
    .from(sessions)
    .where(eq(sessions.eventId, eventId));

  const counts = new Map<string, TrackCounts>();
  for (const row of rows) {
    if (!row.trackId) continue;
    const entry = counts.get(row.trackId) ?? { sessionCount: 0, submissionCount: 0 };
    if (row.isAbstract) entry.submissionCount += 1;
    else entry.sessionCount += 1;
    counts.set(row.trackId, entry);
  }
  return counts;
}

/**
 * Forms whose JSON still names this track. `routing.rules[].trackId` is
 * included alongside the eligible list and the routing default because it is
 * the same shape and the same destination — `routeCategory` returns it and the
 * submit path writes it onto `sessions.track_id`.
 */
async function formsReferencingTrack(
  db: DbHandle,
  eventId: string,
  trackId: string,
): Promise<string[]> {
  const rows = await db
    .select({ name: forms.name, schema: forms.schema })
    .from(forms)
    .where(eq(forms.eventId, eventId));

  return rows
    .filter((row) => {
      const schema = parseFormSchema(row.schema);
      return (
        schema.eligibleTrackIds.includes(trackId) ||
        schema.routing.defaultTrackId === trackId ||
        schema.routing.rules.some((rule) => rule.trackId === trackId)
      );
    })
    .map((row) => row.name);
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function joinParts(parts: string[]): string {
  if (parts.length <= 1) return parts.join("");
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

/**
 * The refusal message, or null when nothing references the track. Pure, so the
 * wording is testable without a database.
 */
export function describeTrackReferences(input: {
  name: string;
  sessionCount: number;
  submissionCount: number;
  formNames: string[];
}): string | null {
  const parts: string[] = [];
  if (input.sessionCount > 0) parts.push(plural(input.sessionCount, "session"));
  if (input.submissionCount > 0) parts.push(plural(input.submissionCount, "submission"));
  if (input.formNames.length > 0) {
    const named = input.formNames.map((name) => `“${name}”`).join(", ");
    parts.push(`${plural(input.formNames.length, "form")} (${named})`);
  }
  if (parts.length === 0) return null;

  const reason =
    input.formNames.length > 0
      ? "A form's eligible-track list and default track are JSON, not foreign keys, so the id would stay on a public form the submit path still accepts."
      : "Deleting it would silently unassign them.";
  return `“${input.name}” is still in use — ${joinParts(parts)}. ${reason} Reassign or clear those first.`;
}

export interface TracksData {
  event: { name: string; slug: string } | null;
  tracks: TrackRow[];
  notice: string | null;
}

export function meta() {
  return [{ title: "Tracks — callboard admin" }];
}

export async function loader({ request }: Route.LoaderArgs): Promise<TracksData> {
  await requireAdmin(request);
  const event = await currentEvent(request);
  if (!event) return { event: null, tracks: [], notice: null };

  const db = getDb();
  const [trackRows, counts] = await Promise.all([
    db
      .select({ id: tracks.id, name: tracks.name, color: tracks.color })
      .from(tracks)
      .where(eq(tracks.eventId, event.id))
      .orderBy(asc(tracks.order), asc(tracks.name)),
    trackCounts(db, event.id),
  ]);

  const url = new URL(request.url);
  const created = url.searchParams.get("created");
  const removed = url.searchParams.get("removed");

  return {
    event: { name: event.name, slug: event.slug },
    tracks: trackRows.map((track) => ({
      ...track,
      sessionCount: counts.get(track.id)?.sessionCount ?? 0,
      submissionCount: counts.get(track.id)?.submissionCount ?? 0,
    })),
    notice: created
      ? `Added “${created}”.`
      : removed
        ? `Removed “${removed}”. Nothing was pointing at it.`
        : null,
  };
}

const COLOR_RE = /^#[0-9a-fA-F]{6}$/;

function parseColor(value: FormDataEntryValue | null): string | null {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  return COLOR_RE.test(raw) ? raw : null;
}

export async function action({ request }: Route.ActionArgs) {
  await requireAdmin(request);
  const event = await currentEvent(request);
  if (!event) return { ok: false as const, error: "No event has been set up yet." };

  const db = getDb();
  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "");

  if (intent === "create") {
    const name = String(formData.get("name") ?? "").trim();
    if (!name) return { ok: false as const, error: "Track name is required." };
    if (name.length > 120) {
      return { ok: false as const, error: "Track name is capped at 120 characters." };
    }

    const clash = await db.query.tracks.findFirst({
      where: and(eq(tracks.eventId, event.id), eq(tracks.name, name)),
    });
    if (clash) return { ok: false as const, error: `“${name}” already exists.` };

    const existing = await db
      .select({ id: tracks.id })
      .from(tracks)
      .where(eq(tracks.eventId, event.id));

    await db.insert(tracks).values({
      eventId: event.id,
      name,
      color: parseColor(formData.get("color")),
      order: existing.length,
    });
    return redirect(`/admin/agenda/tracks?created=${encodeURIComponent(name)}`);
  }

  if (intent === "update") {
    const trackId = String(formData.get("trackId") ?? "");
    const target = await db.query.tracks.findFirst({
      where: and(eq(tracks.id, trackId), eq(tracks.eventId, event.id)),
    });
    if (!target) return { ok: false as const, error: "That track is not on this event." };

    const name = String(formData.get("name") ?? "").trim();
    if (!name) return { ok: false as const, error: "Track name is required." };

    const clash = await db.query.tracks.findFirst({
      where: and(eq(tracks.eventId, event.id), eq(tracks.name, name)),
    });
    if (clash && clash.id !== trackId) {
      return { ok: false as const, error: `“${name}” already exists.` };
    }

    await db
      .update(tracks)
      .set({ name, color: parseColor(formData.get("color")), updatedAt: new Date() })
      .where(eq(tracks.id, trackId));
    return redirect("/admin/agenda/tracks");
  }

  if (intent === "delete") {
    const trackId = String(formData.get("trackId") ?? "");
    const target = await db.query.tracks.findFirst({
      where: and(eq(tracks.id, trackId), eq(tracks.eventId, event.id)),
    });
    if (!target) return { ok: false as const, error: "That track is not on this event." };

    const [counts, formNames] = await Promise.all([
      trackCounts(db, event.id),
      formsReferencingTrack(db, event.id, trackId),
    ]);
    const inUse = describeTrackReferences({
      name: target.name,
      sessionCount: counts.get(trackId)?.sessionCount ?? 0,
      submissionCount: counts.get(trackId)?.submissionCount ?? 0,
      formNames,
    });
    if (inUse) return { ok: false as const, error: inUse };

    await db.delete(tracks).where(eq(tracks.id, trackId));
    return redirect(`/admin/agenda/tracks?removed=${encodeURIComponent(target.name)}`);
  }

  return { ok: false as const, error: `Unknown intent "${intent}".` };
}

const FIELD =
  "rounded border border-gray-300 px-2 py-1 text-sm dark:border-gray-700 dark:bg-gray-900";
const BUTTON = buttonClass("primary");
const GHOST = buttonClass("secondary");

function ColorDot({ color }: { color: string | null }) {
  return (
    <span
      aria-hidden="true"
      className="inline-block size-3 rounded-full border border-gray-300 dark:border-gray-700"
      style={{ backgroundColor: color ?? "transparent" }}
    />
  );
}

export function TracksScreen(data: TracksData) {
  return (
    <div>
      <div className="mb-4 flex flex-wrap items-baseline gap-3">
        <h2 className="text-xl font-semibold">Tracks</h2>
        <p className="text-sm text-gray-500">
          Groups sessions on the agenda and populates CFP eligible-track pickers.
        </p>
        <a className={`${GHOST} ml-auto`} href="/admin/agenda">
          Back to agenda
        </a>
      </div>

      {data.notice ? (
        <p className="mb-3 rounded border border-gray-300 bg-gray-50 p-2 text-sm dark:border-gray-700 dark:bg-gray-900">
          {data.notice}
        </p>
      ) : null}

      {!data.event ? (
        <p className="rounded-lg border border-gray-200 p-6 text-sm dark:border-gray-800">
          No event yet — tracks belong to an event, so create one first.
        </p>
      ) : (
        <>
          <form
            method="post"
            className="mb-6 flex flex-wrap items-end gap-2 rounded-lg border border-gray-200 p-3 dark:border-gray-800"
          >
            <input type="hidden" name="intent" value="create" />
            <label className="flex flex-col gap-1 text-xs">
              Track name
              <input name="name" required className={FIELD} placeholder="Community" />
            </label>
            <label className="flex flex-col gap-1 text-xs">
              Color
              <input
                name="color"
                type="color"
                defaultValue="#2563eb"
                className="h-[30px] w-12 rounded border border-gray-300 dark:border-gray-700"
              />
            </label>
            <button type="submit" className={BUTTON}>
              Add track
            </button>
          </form>

          {data.tracks.length === 0 ? (
            <p className="rounded border border-dashed border-gray-300 p-6 text-sm text-gray-500 dark:border-gray-700">
              No tracks yet. Add the first one above — CFP forms and the agenda's
              Track lane view need at least one.
            </p>
          ) : (
            <ul className="space-y-2">
              {data.tracks.map((track) => (
                <li
                  key={track.id}
                  data-track-row={track.id}
                  className="rounded-lg border border-gray-200 p-3 dark:border-gray-800"
                >
                  <div className="flex flex-wrap items-end gap-2">
                    <form method="post" className="flex flex-wrap items-end gap-2">
                      <input type="hidden" name="intent" value="update" />
                      <input type="hidden" name="trackId" value={track.id} />
                      <label className="flex flex-col gap-1 text-xs">
                        Name
                        <input name="name" defaultValue={track.name} className={FIELD} />
                      </label>
                      <label className="flex flex-col gap-1 text-xs">
                        Color
                        <input
                          name="color"
                          type="color"
                          defaultValue={track.color ?? "#2563eb"}
                          className="h-[30px] w-12 rounded border border-gray-300 dark:border-gray-700"
                        />
                      </label>
                      <button type="submit" className={BUTTON}>
                        Save
                      </button>
                    </form>
                    <span
                      data-track-usage={track.id}
                      className="flex items-center gap-1 text-xs text-gray-500"
                    >
                      <ColorDot color={track.color} />
                      {plural(track.sessionCount, "session")} ·{" "}
                      {plural(track.submissionCount, "submission")}
                    </span>
                    <form method="post" className="ml-auto">
                      <input type="hidden" name="intent" value="delete" />
                      <input type="hidden" name="trackId" value={track.id} />
                      <button type="submit" className={GHOST}>
                        Delete
                      </button>
                    </form>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}

export default function AdminAgendaTracks({ loaderData, actionData }: Route.ComponentProps) {
  const error = (actionData as { ok?: boolean; error?: string } | undefined)?.error;
  return (
    <>
      {error ? (
        <p className="mb-3 rounded border border-red-400 bg-red-50 p-2 text-sm text-red-800 dark:bg-red-950 dark:text-red-200">
          {error}
        </p>
      ) : null}
      <TracksScreen {...loaderData} />
    </>
  );
}
