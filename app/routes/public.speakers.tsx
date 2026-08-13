/** Public speaker directory and gallery: one SSR loader, two zero-JS views. */
import { Link } from "react-router";

import { buttonClass } from "~/components/portal-ui";
import { eyebrowClass, linkClass, Shell } from "~/components/shell";
import { SpeakerMonogram } from "~/components/speaker-monogram";
import { getDb } from "~/db/client.server";
import { organizersEntryHref } from "~/lib/env.server";
import {
  getPublicSpeakerEvent,
  listPublicSpeakers,
  publicSpeakerPhotoHref,
} from "~/lib/public-speakers.server";
import type { Route } from "./+types/public.speakers";

export function meta({ loaderData }: Route.MetaArgs) {
  return [
    {
      title: loaderData
        ? `Speakers — ${loaderData.event.name}`
        : "Speakers",
    },
  ];
}

export async function loader({ params, request }: Route.LoaderArgs) {
  const db = getDb();
  const event = await getPublicSpeakerEvent(db, params.slug);
  if (!event) throw new Response("Event not found", { status: 404 });

  const url = new URL(request.url);
  const q = url.searchParams.get("q")?.trim() ?? "";
  const view: "list" | "gallery" =
    url.searchParams.get("view") === "gallery" ? "gallery" : "list";
  const { speakers, total } = await listPublicSpeakers(db, event.id, q);

  return {
    event: { name: event.name, slug: event.slug },
    q,
    view,
    total,
    count: speakers.length,
    organizersHref: organizersEntryHref(),
    /*
     * The photo URL is built HERE, in the loader, not in the components below.
     * `publicSpeakerPhotoHref` lives in a `.server` module, and React Router
     * only strips server imports from `loader`/`action`/`middleware`/`headers`
     * — a component reaching for one fails the client build with
     * "Server-only module referenced by client", which surfaces as a Vite error
     * overlay swallowing clicks on every page. Mapping here also means the
     * opaque `photoVersion` never has to be reassembled in three places.
     */
    speakers: speakers.map((speaker) => ({
      ...speaker,
      photoHref: speaker.photoVersion
        ? publicSpeakerPhotoHref(event.slug, speaker.id, speaker.photoVersion)
        : null,
    })),
  };
}

type Speaker = Awaited<ReturnType<typeof loader>>["speakers"][number];

function RoleLine({ speaker, centered = false }: { speaker: Speaker; centered?: boolean }) {
  if (!speaker.title && !speaker.company) return null;
  return (
    <p
      className={[
        "mt-0.5 text-sm text-gray-600 dark:text-gray-400",
        centered ? "text-center" : "",
      ].join(" ")}
    >
      {speaker.title ? <span data-speaker-title>{speaker.title}</span> : null}
      {speaker.title && speaker.company ? <span aria-hidden="true"> · </span> : null}
      {speaker.company ? <span data-speaker-company>{speaker.company}</span> : null}
    </p>
  );
}

/**
 * The directory's view + search live in the URL, never in component state, so
 * that a round trip through a speaker's detail page can put them back exactly
 * (EMB-13). `speakerHref` carries the SAME pair forward into the detail link;
 * `public.speaker.tsx` reads it back to build its Back link.
 */
export function speakerListSearch(view: "list" | "gallery", q: string): string {
  const search = new URLSearchParams();
  if (view === "gallery") search.set("view", "gallery");
  if (q) search.set("q", q);
  return search.toString();
}

function viewHref(slug: string, view: "list" | "gallery", q: string): string {
  const suffix = speakerListSearch(view, q);
  return `/e/${slug}/speakers${suffix ? `?${suffix}` : ""}`;
}

function speakerHref(
  slug: string,
  personId: string,
  view: "list" | "gallery",
  q: string,
): string {
  const suffix = speakerListSearch(view, q);
  return `/e/${slug}/speakers/${personId}${suffix ? `?${suffix}` : ""}`;
}

function ViewToggle({
  slug,
  view,
  q,
}: {
  slug: string;
  view: "list" | "gallery";
  q: string;
}) {
  return (
    <nav
      aria-label="Speaker view"
      className="inline-flex rounded-xl bg-gray-100 p-1 text-sm dark:bg-gray-800"
    >
      {(["list", "gallery"] as const).map((option) => (
        <Link
          key={option}
          to={viewHref(slug, option, q)}
          aria-current={view === option ? "page" : undefined}
          className={[
            "rounded-lg px-3 py-1.5 font-medium capitalize transition-colors",
            view === option
              ? "bg-white text-gray-900 shadow-sm ring-1 ring-gray-200 dark:bg-gray-900 dark:text-gray-100 dark:ring-gray-700"
              : "text-gray-600 hover:text-gray-900 dark:text-gray-300 dark:hover:text-white",
          ].join(" ")}
        >
          {option}
        </Link>
      ))}
    </nav>
  );
}

function ListView({
  speakers,
  slug,
  q,
}: {
  speakers: Speaker[];
  slug: string;
  q: string;
}) {
  const groups = speakers.reduce<{ initial: string; speakers: Speaker[] }[]>((all, speaker) => {
    const last = all.at(-1);
    if (last?.initial === speaker.groupInitial) last.speakers.push(speaker);
    else all.push({ initial: speaker.groupInitial, speakers: [speaker] });
    return all;
  }, []);

  return (
    /*
     * ONE card for the whole directory, MEASURED.
     *
     * Before, every letter opened its own bordered, shadowed card — and on a
     * six-speaker programme every letter holds exactly one person, so the page
     * was six floating cards each holding a single row. Each row then spent an
     * 1104px column on a 48px monogram, two short lines, and "1 session" pinned
     * 600px away at the far edge.
     *
     * The letter is a band inside the card now, which is what an index letter
     * is: a divider in a list, not a heading over a card. The measure is the
     * other half — a person's name and job title do not need 1104px, and a
     * draft that instead ran the rows two-up looked worse than either, because
     * every one-person letter left a bordered empty cell beside it. The GALLERY
     * view is where this data goes wide; the list stays a list.
     */
    <div
      data-speaker-view="list"
      className="mx-auto max-w-3xl overflow-hidden rounded-xl border border-gray-200 bg-white shadow-card dark:border-gray-800 dark:bg-gray-900"
    >
      {groups.map((group) => (
        <section
          key={group.initial}
          aria-labelledby={`speaker-group-${group.initial}`}
          className="border-t border-gray-200 first:border-t-0 dark:border-gray-800"
        >
          <h2
            id={`speaker-group-${group.initial}`}
            className={`bg-gray-50 px-4 py-1.5 ${eyebrowClass} tracking-widest dark:bg-gray-950/60`}
          >
            {group.initial}
          </h2>
          <ul>
            {group.speakers.map((speaker) => (
              <li
                key={speaker.id}
                className="border-t border-gray-100 first:border-t-0 dark:border-gray-800"
              >
                <Link
                  to={speakerHref(slug, speaker.id, "list", q)}
                  data-speaker-row={speaker.id}
                  aria-label={`${speaker.displayName}, ${speaker.sessionCount} ${speaker.sessionCount === 1 ? "session" : "sessions"}`}
                  className="flex h-full items-center gap-3 p-3 transition-colors hover:bg-gray-50 sm:p-4 dark:hover:bg-gray-800/60"
                >
                  <SpeakerMonogram
                    personId={speaker.id}
                    initials={speaker.initials}
                    photoHref={speaker.photoHref}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block font-semibold tracking-tight">
                      {speaker.displayName}
                    </span>
                    <RoleLine speaker={speaker} />
                  </span>
                  <span className="shrink-0 text-xs text-gray-500 tabular-nums sm:text-sm dark:text-gray-400">
                    {speaker.sessionCount} {speaker.sessionCount === 1 ? "session" : "sessions"}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

function GalleryView({
  speakers,
  slug,
  q,
}: {
  speakers: Speaker[];
  slug: string;
  q: string;
}) {
  return (
    <ul
      data-speaker-view="gallery"
      className="grid grid-cols-2 gap-3 sm:grid-cols-3 sm:gap-4 lg:grid-cols-4"
    >
      {speakers.map((speaker) => (
        <li key={speaker.id}>
          <Link
            to={speakerHref(slug, speaker.id, "gallery", q)}
            data-speaker-card={speaker.id}
            aria-label={`${speaker.displayName}, ${speaker.sessionCount} ${speaker.sessionCount === 1 ? "session" : "sessions"}`}
            className="block h-full rounded-2xl border border-gray-200 bg-white p-2 shadow-card transition hover:-translate-y-0.5 hover:border-blue-300 sm:p-3 dark:border-gray-800 dark:bg-gray-900 dark:hover:border-blue-800"
          >
            <SpeakerMonogram
              personId={speaker.id}
              initials={speaker.initials}
              size="tile"
              photoHref={speaker.photoHref}
            />
            <span className="block px-1 pt-3 pb-2 text-center">
              <span className="block font-semibold tracking-tight">{speaker.displayName}</span>
              <RoleLine speaker={speaker} centered />
              <span className="mt-2 block text-xs text-gray-500 dark:text-gray-400">
                {speaker.sessionCount} {speaker.sessionCount === 1 ? "session" : "sessions"}
              </span>
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
}

export default function PublicSpeakers({ loaderData }: Route.ComponentProps) {
  const { event, q, view, total, count, speakers, organizersHref } = loaderData;
  const clearHref = viewHref(event.slug, view, "");

  return (
    <Shell
      title={`${event.name} — Speakers`}
      titleSize="display"
      nav={[
        { to: `/e/${event.slug}`, label: "Overview", end: true },
        { to: `/e/${event.slug}/schedule`, label: "Schedule" },
        { to: `/e/${event.slug}/speakers`, label: "Speakers" },
      ]}
      organizersHref={organizersHref}
    >
      <div className="space-y-5">
        {/* The toolbar takes the same measure as the view under it. A 1104px
            search bar over a 768px list reads as two unrelated pages. */}
        <div
          className={`flex flex-col gap-3 rounded-2xl border border-gray-200 bg-white p-4 shadow-card sm:flex-row sm:items-end sm:justify-between dark:border-gray-800 dark:bg-gray-900 ${
            view === "list" ? "mx-auto max-w-3xl" : ""
          }`}
        >
          <form method="get" className="flex min-w-0 flex-1 items-end gap-2">
            <label className="min-w-0 flex-1 text-sm font-medium">
              Search speakers
              <input
                type="search"
                name="q"
                defaultValue={q}
                placeholder="Name"
                className="mt-1 block w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-base text-gray-900 shadow-sm placeholder:text-gray-400 focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20 dark:border-gray-700 dark:bg-gray-950 dark:text-gray-100"
              />
            </label>
            {view === "gallery" ? <input type="hidden" name="view" value="gallery" /> : null}
            {/*
              * `buttonClass("primary")`, not the blue-700 fill this carried.
              * It was a SECOND primary blue: blue-700 in light and blue-600 in
              * dark, on a public page a visitor reaches from the same nav as
              * pages whose primary is blue-600 in both. One product, one
              * primary — enforced by `design-tokens-scan.test.ts`.
              */}
            <button type="submit" className={buttonClass("primary")}>
              Search
            </button>
          </form>
          <ViewToggle slug={event.slug} view={view} q={q} />
        </div>

        <p
          data-speaker-count
          className={`text-sm text-gray-600 dark:text-gray-400 ${
            view === "list" ? "mx-auto max-w-3xl" : ""
          }`}
        >
          {q ? `${count} of ${total} speakers` : `${total} speaker${total === 1 ? "" : "s"}`}
        </p>

        {speakers.length === 0 ? (
          <div
            data-speaker-empty
            className={`rounded-xl border border-dashed border-gray-300 bg-white/60 p-8 text-center dark:border-gray-700 dark:bg-gray-900/40 ${
              view === "list" ? "mx-auto max-w-3xl" : ""
            }`}
          >
            <p className="font-medium">
              {q ? "No speakers match that search." : "Speakers have not been announced yet."}
            </p>
            <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
              {q
                ? "Try another name or clear the search to see the full directory."
                : "Speaker profiles appear here when their sessions join the public programme."}
            </p>
            {q ? (
              <p className="mt-4">
                <Link to={clearHref} className={linkClass}>
                  Clear search
                </Link>
              </p>
            ) : null}
          </div>
        ) : view === "gallery" ? (
          <GalleryView speakers={speakers} slug={event.slug} q={q} />
        ) : (
          <ListView speakers={speakers} slug={event.slug} q={q} />
        )}
      </div>
    </Shell>
  );
}
