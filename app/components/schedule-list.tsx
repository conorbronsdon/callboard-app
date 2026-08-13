/**
 * The leaf renderers for a published session, shared by every public surface:
 * the schedule page, the session detail page, and the iframe widget.
 *
 * These live here rather than in `routes/public.schedule.tsx` because a route
 * module that imports another route module defeats the RR/Vite plugin's
 * per-route stripping of server exports — it drags drizzle and the D1 client
 * into the browser bundle. The chips and the speaker list are pure
 * presentation, so they belong in `components/`.
 *
 * `EmbedScheduleList` is the widget's own shell: SSR, zero client JS, no
 * search box and no localStorage itinerary. The public page keeps its
 * interactive chrome; both render sessions through the SAME two leaves, so a
 * field cannot appear on one surface and not the other.
 */
import { TrackChip } from "~/components/shell";
import {
  speakerRole,
  type PublicDay,
  type PublicSlot,
  type PublicSpeaker,
} from "~/lib/agenda/public-schedule";
import type { EmbedDensity } from "~/lib/embeds";

export function PublicSlotChips({ slot }: { slot: PublicSlot }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {slot.trackName ? (
        <span data-session-track={slot.trackName}>
          <TrackChip name={slot.trackName} color={slot.trackColor} />
        </span>
      ) : null}
      {slot.formatName ? (
        <span
          data-session-format={slot.formatName}
          className="rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-700 ring-1 ring-gray-500/20 ring-inset dark:bg-gray-800 dark:text-gray-200 dark:ring-gray-400/30"
        >
          Format: {slot.formatName}
        </span>
      ) : null}
      {slot.roomName ? (
        <span
          data-session-room={slot.roomName}
          className="rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-700 ring-1 ring-gray-500/20 ring-inset dark:bg-gray-800 dark:text-gray-200 dark:ring-gray-400/30"
        >
          {slot.roomName}
        </span>
      ) : null}
    </div>
  );
}

export function PublicSpeakerList({
  sessionId,
  speakers,
  eventSlug,
}: {
  sessionId: string;
  speakers: readonly PublicSpeaker[];
  /*
   * When set, each chip links to that speaker's public profile
   * (`/e/:slug/speakers/:personId`). The embed widgets render the same list
   * without a slug and stay plain text — an iframe on a third-party page is not
   * the place to navigate the host document to a Callboard route.
   */
  eventSlug?: string;
}) {
  if (speakers.length === 0) return null;
  const chipClass =
    "block rounded-lg bg-gray-100 px-2.5 py-1.5 text-xs ring-1 ring-gray-500/20 ring-inset dark:bg-gray-800 dark:ring-gray-400/30";
  return (
    <div className="mt-3">
      <span className="sr-only">Speakers: </span>
      <ul aria-label="Speakers" className="flex flex-wrap gap-2">
        {/*
         * Position is intentional: two participants can share a name, so a
         * name key can make React reuse the wrong speaker node on re-render.
         */}
        {speakers.map((speaker, index) => {
          const role = speakerRole(speaker);
          const body = (
            <>
              <span data-speaker-name className="block font-semibold text-gray-900 dark:text-gray-100">
                {speaker.name}
              </span>
              {role ? (
                <span data-speaker-role className="block text-gray-600 dark:text-gray-300">
                  {role}
                </span>
              ) : null}
            </>
          );
          return (
            <li key={`${sessionId}-${index}`} data-session-speaker className="text-xs">
              {eventSlug ? (
                <a
                  data-speaker-link
                  href={`/e/${eventSlug}/speakers/${speaker.personId}`}
                  className={`${chipClass} transition hover:bg-gray-200 hover:ring-gray-500/40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600 dark:hover:bg-gray-700 dark:hover:ring-gray-400/50`}
                >
                  {body}
                </a>
              ) : (
                <div className={chipClass}>{body}</div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** Compact, non-interactive day/session list for the iframe widget. */
export function EmbedScheduleList({
  days,
  total,
  timezone,
  density = "full",
  emptyState,
}: {
  days: readonly PublicDay[];
  total: number;
  timezone: string;
  density?: EmbedDensity;
  emptyState?: { title: string; description: string };
}) {
  if (total === 0) {
    return (
      <div className="rounded-xl border border-dashed border-gray-300 bg-white/60 p-5 text-center dark:border-gray-700 dark:bg-gray-900/40">
        <p className="font-medium">
          {emptyState?.title ?? "The schedule is not published yet."}
        </p>
        <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
          {emptyState?.description ??
            "Sessions appear here once the organisers publish them. Check back soon."}
        </p>
      </div>
    );
  }

  return (
    <>
      <p className="mb-3 text-xs text-gray-600 dark:text-gray-400">
        {total} session{total === 1 ? "" : "s"} · all times {timezone}
      </p>
      {days.map((day) => (
        <section key={day.day} className="mb-5">
          <h2 className="sticky top-0 z-10 -mx-4 mb-2 bg-gray-50/90 px-4 py-1.5 text-base font-semibold backdrop-blur dark:bg-gray-950/90">
            {day.label}
          </h2>
          <ol className="space-y-1.5">
            {day.sessions.map((slot) => (
              <li
                key={slot.id}
                data-public-session={slot.id}
                className="rounded-xl border border-gray-200 bg-white p-3 shadow-card dark:border-gray-800 dark:bg-gray-900"
              >
                <div className="flex flex-col gap-x-4 gap-y-2 sm:flex-row">
                  {/*
                   * Fixed-width, tabular, monospace: the times form a column
                   * you can run your eye down instead of a ragged edge that
                   * moves with the length of each label.
                   */}
                  <span className="font-mono text-xs font-medium whitespace-nowrap tabular-nums text-gray-700 sm:w-36 sm:shrink-0 dark:text-gray-300">
                    {slot.timeLabel}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-semibold tracking-tight">{slot.title}</p>
                    <div className="mt-1.5">
                      <PublicSlotChips slot={slot} />
                    </div>
                    {density === "full" && slot.description ? (
                      <p className="mt-1.5 line-clamp-3 text-xs leading-5 text-gray-600 dark:text-gray-300">
                        {slot.description}
                      </p>
                    ) : null}
                    {density === "full" ? (
                      <PublicSpeakerList sessionId={slot.id} speakers={slot.speakers} />
                    ) : null}
                  </div>
                </div>
              </li>
            ))}
          </ol>
        </section>
      ))}
    </>
  );
}

export function EmbedAgendaByDay({
  days,
  total,
  timezone,
  density = "full",
  emptyState,
}: {
  days: readonly PublicDay[];
  total: number;
  timezone: string;
  density?: EmbedDensity;
  emptyState?: { title: string; description: string };
}) {
  if (total === 0) {
    return (
      <div className="rounded-xl border border-dashed border-gray-300 bg-white/60 p-5 text-center dark:border-gray-700 dark:bg-gray-900/40">
        <p className="font-medium">
          {emptyState?.title ?? "The schedule is not published yet."}
        </p>
        <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
          {emptyState?.description ??
            "Sessions appear here once the organisers publish them. Check back soon."}
        </p>
      </div>
    );
  }

  return (
    <>
      <p className="mb-3 text-xs text-gray-600 dark:text-gray-400">
        {total} session{total === 1 ? "" : "s"} · all times {timezone}
      </p>
      {days.map((day) => (
        <section key={day.day} data-embed-agenda-day={day.day} className="mb-5">
          <h2 className="mb-2 border-b border-gray-200 pb-2 text-base font-semibold dark:border-gray-800">
            {day.label} · {day.sessions.length} session{day.sessions.length === 1 ? "" : "s"}
          </h2>
          <ol className="divide-y divide-gray-200 rounded-xl border border-gray-200 bg-white px-3 dark:divide-gray-800 dark:border-gray-800 dark:bg-gray-900">
            {day.sessions.map((slot) => (
              <li
                key={slot.id}
                data-public-session={slot.id}
                className="grid gap-2 py-3 sm:grid-cols-[9rem_1fr] sm:gap-4"
              >
                <span className="font-mono text-xs font-medium whitespace-nowrap tabular-nums text-gray-700 dark:text-gray-300">
                  {slot.timeLabel}
                </span>
                <div className="min-w-0">
                  <p className="text-sm font-semibold tracking-tight">{slot.title}</p>
                  {slot.roomName ? (
                    <p data-session-room={slot.roomName} className="mt-0.5 text-xs text-gray-600 dark:text-gray-400">
                      {slot.roomName}
                    </p>
                  ) : null}
                  {density === "full" ? (
                    <>
                      <div className="mt-1.5">
                        <PublicSlotChips slot={slot} />
                      </div>
                      <PublicSpeakerList sessionId={slot.id} speakers={slot.speakers} />
                    </>
                  ) : null}
                </div>
              </li>
            ))}
          </ol>
        </section>
      ))}
    </>
  );
}
