/** Public speaker profile with only that speaker's published programme slots. */
import { Link } from "react-router";

import { linkClass, Shell, TrackChip } from "~/components/shell";
import { SpeakerMonogram } from "~/components/speaker-monogram";
import { getDb } from "~/db/client.server";
import { dayKeyOf, formatDayLabel, formatRangeLabel } from "~/lib/agenda/schedule";
import {
  getPublicSpeakerEvent,
  getPublicSpeakerProfile,
  listPublicSpeakerSessions,
  publicSessionHref,
  publicSpeakerPhotoHref,
} from "~/lib/public-speakers.server";
import type { Route } from "./+types/public.speaker";

export function meta({ loaderData }: Route.MetaArgs) {
  return [
    {
      title: loaderData
        ? `${loaderData.speaker.displayName} — ${loaderData.event.name}`
        : "Speaker",
    },
  ];
}

/**
 * A bio short enough to read at a glance gets no "Show more" — an expander over
 * two lines of text is noise. Every seeded bio is well past this, so the demo
 * shows the control; the fixture's one-line bio is the control's complement.
 */
export const BIO_CLAMP_CHARS = 160;

export async function loader({ params, request }: Route.LoaderArgs) {
  const db = getDb();
  const event = await getPublicSpeakerEvent(db, params.slug);
  if (!event) throw new Response("Event not found", { status: 404 });

  /*
   * EMB-13: the directory carries its view and search in the URL, and the card
   * link forwards both here. Rebuilding the Back link from those params is what
   * puts the visitor back in the GRID they came from, with their search intact
   * — a component-state "remember the last view" cannot survive this navigation
   * because the detail page is a different route with its own document.
   */
  const requestUrl = new URL(request.url);
  const fromGallery = requestUrl.searchParams.get("view") === "gallery";
  const backQuery = requestUrl.searchParams.get("q")?.trim() ?? "";
  const backSearch = new URLSearchParams();
  if (fromGallery) backSearch.set("view", "gallery");
  if (backQuery) backSearch.set("q", backQuery);
  const backSuffix = backSearch.toString();

  const speaker = await getPublicSpeakerProfile(db, event.id, params.personId);
  if (!speaker) throw new Response("Speaker not found", { status: 404 });

  const sessionRows = await listPublicSpeakerSessions(db, event.id, speaker.id);
  const publicSessions = sessionRows.map((session) => ({
    id: session.id,
    title: session.title,
    dateLabel: formatDayLabel(dayKeyOf(session.startsAt, event.timezone), event.timezone),
    timeLabel: formatRangeLabel(session.startsAt, session.endsAt, event.timezone),
    roomName: session.roomName,
    trackName: session.trackName,
    trackColor: session.trackColor,
    href: publicSessionHref(event.slug, session.id),
  }));

  return {
    event: { name: event.name, slug: event.slug },
    speaker: {
      id: speaker.id,
      displayName: speaker.displayName,
      initials: speaker.initials,
      title: speaker.title,
      company: speaker.company,
      bio: speaker.bio,
      bioIsLong: (speaker.bio?.length ?? 0) > BIO_CLAMP_CHARS,
      photoHref: speaker.photoVersion
        ? publicSpeakerPhotoHref(event.slug, speaker.id, speaker.photoVersion)
        : null,
    },
    sessions: publicSessions,
    back: {
      href: `/e/${event.slug}/speakers${backSuffix ? `?${backSuffix}` : ""}`,
      label: fromGallery ? "← Back to the speaker gallery" : "← Back to speakers",
      view: fromGallery ? ("gallery" as const) : ("list" as const),
      q: backQuery,
    },
  };
}

export default function PublicSpeaker({ loaderData }: Route.ComponentProps) {
  const { event, speaker, sessions, back } = loaderData;

  return (
    <Shell
      title={speaker.displayName}
      titleSize="display"
      subtitle={event.name}
      nav={[
        { to: `/e/${event.slug}`, label: "Overview", end: true },
        { to: `/e/${event.slug}/schedule`, label: "Schedule" },
        { to: `/e/${event.slug}/speakers`, label: "Speakers" },
      ]}
    >
      <div data-speaker-detail={speaker.id} className="max-w-3xl space-y-6">
        <Link
          to={back.href}
          data-speaker-back={back.view}
          className={`inline-flex text-sm ${linkClass}`}
        >
          {back.label}
        </Link>

        <section className="rounded-2xl border border-gray-200 bg-white p-5 shadow-card sm:p-7 dark:border-gray-800 dark:bg-gray-900">
          <div className="flex flex-col gap-5 sm:flex-row sm:items-start">
            <SpeakerMonogram
              personId={speaker.id}
              initials={speaker.initials}
              size="profile"
              photoHref={speaker.photoHref}
            />
            <div className="min-w-0">
              <h2 className="text-3xl font-semibold tracking-tight">{speaker.displayName}</h2>
              {speaker.title || speaker.company ? (
                <p className="mt-1 text-base text-gray-600 dark:text-gray-300">
                  {speaker.title ? <span data-speaker-title>{speaker.title}</span> : null}
                  {speaker.title && speaker.company ? <span aria-hidden="true"> · </span> : null}
                  {speaker.company ? <span data-speaker-company>{speaker.company}</span> : null}
                </p>
              ) : null}
              {speaker.bio && speaker.bioIsLong ? (
                /*
                 * The full bio is in the SSR HTML twice on purpose — once
                 * clamped in the summary, once whole in the body — so it reads
                 * with styles and scripts off. `group-open:hidden` drops the
                 * clamped copy the moment it expands, or the first three lines
                 * would appear a second time. Same block the schedule cards use.
                 */
                <details
                  data-speaker-bio
                  className="group mt-5 max-w-prose text-sm leading-6 text-gray-700 dark:text-gray-300"
                >
                  <summary className="cursor-pointer list-none">
                    <span className="line-clamp-3 group-open:hidden">{speaker.bio}</span>
                    <span className={`${linkClass} mt-1 inline-block`}>
                      <span className="group-open:hidden">Show more</span>
                      <span className="hidden group-open:inline">Show less</span>
                    </span>
                  </summary>
                  <p className="mt-2">{speaker.bio}</p>
                </details>
              ) : speaker.bio ? (
                <p data-speaker-bio className="mt-5 max-w-prose text-sm leading-6 text-gray-700 dark:text-gray-300">
                  {speaker.bio}
                </p>
              ) : (
                <p data-speaker-bio-empty className="mt-5 text-sm italic text-gray-500 dark:text-gray-400">
                  No biography yet. Speakers write their own from the speaker portal, and it
                  appears here as soon as it is saved.
                </p>
              )}
            </div>
          </div>
        </section>

        <section aria-labelledby="speaker-sessions-heading">
          <div className="mb-3 flex flex-wrap items-end justify-between gap-2">
            <h2 id="speaker-sessions-heading" className="text-xl font-semibold tracking-tight">
              Sessions ({sessions.length})
            </h2>
            <Link to={`/e/${event.slug}/schedule`} className={`text-sm ${linkClass}`}>
              View full schedule
            </Link>
          </div>
          <ul className="space-y-3">
            {sessions.map((session) => (
              <li key={session.id} data-speaker-session={session.id}>
                <Link
                  to={session.href}
                  className="block rounded-xl border border-gray-200 bg-white p-4 shadow-card transition hover:border-blue-300 dark:border-gray-800 dark:bg-gray-900 dark:hover:border-blue-800"
                >
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="font-semibold tracking-tight">{session.title}</span>
                    {session.trackName ? (
                      <TrackChip name={session.trackName} color={session.trackColor} />
                    ) : null}
                  </span>
                  <span className="mt-2 grid gap-1 text-sm text-gray-600 sm:grid-cols-[minmax(0,1fr)_auto] dark:text-gray-400">
                    <span data-speaker-session-time>
                      {session.dateLabel} · {session.timeLabel}
                    </span>
                    <span data-speaker-session-room>
                      {session.roomName ?? "Room to be announced"}
                    </span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </Shell>
  );
}
