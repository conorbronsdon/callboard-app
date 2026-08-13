/**
 * Speaker-gallery widget: the tile grid the public `?view=gallery` renders,
 * without the chrome, the toggle or the search box — a host page owns those.
 *
 * It reuses `listPublicSpeakers`, the directory's own projection, so the
 * surname ordering and the never-select-headshotKey/email rule hold here too
 * rather than being re-derived in a second query that could drift (EMB-16).
 * The tile image is the shared `SpeakerMonogram`, which now carries a consented
 * headshot when the speaker has one and the initials tile when they have not —
 * the photo lane changed one component and every surface followed.
 */
import { EmbedShell } from "~/components/embed-shell";
import { SpeakerMonogram } from "~/components/speaker-monogram";
import { getDb } from "~/db/client.server";
import { resolveEmbedOptions } from "~/lib/embeds.server";
import {
  getPublicSpeakerEvent,
  listPublicSpeakers,
  publicSpeakerPhotoHref,
} from "~/lib/public-speakers.server";
import type { Route } from "./+types/embed.gallery";

export async function loader({ params, request }: Route.LoaderArgs) {
  const url = new URL(request.url);
  const { theme, track, accent, density } = await resolveEmbedOptions(
    params.slug,
    url,
    "gallery",
  );
  const db = getDb();
  const event = await getPublicSpeakerEvent(db, params.slug);
  if (!event) throw new Response("Event not found", { status: 404 });
  const { speakers, total } = await listPublicSpeakers(db, event.id, "");

  return {
    event: { name: event.name, slug: event.slug },
    // Built in the loader: `publicSpeakerPhotoHref` is server-only, and a
    // component importing it breaks the client build. Same note as
    // public.speakers.tsx.
    speakers: speakers.map((speaker) => ({
      ...speaker,
      photoHref: speaker.photoVersion
        ? publicSpeakerPhotoHref(event.slug, speaker.id, speaker.photoVersion)
        : null,
    })),
    total,
    theme,
    track,
    accent,
    density,
  };
}

export default function EmbedGallery({ loaderData }: Route.ComponentProps) {
  const { event, speakers, total, theme, accent, density } = loaderData;
  return (
    <EmbedShell
      theme={theme}
      accent={accent}
      density={density}
      eyebrow="Speaker gallery"
      title={event.name}
      testId="embed-gallery"
      sourceHref={`/e/${event.slug}/speakers?view=gallery`}
    >
      {total === 0 ? (
        <div className="rounded-xl border border-dashed border-gray-300 bg-white/60 p-5 text-center dark:border-gray-700 dark:bg-gray-900/40">
          <p className="font-medium">No speakers are published yet.</p>
          <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
            Speakers appear here once their sessions are published.
          </p>
        </div>
      ) : (
        <>
          {density === "full" ? (
            <p className="mb-3 text-xs text-gray-600 dark:text-gray-400">
              {total} speaker{total === 1 ? "" : "s"}
            </p>
          ) : null}
          <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
            {speakers.map((speaker) => (
              <li
                key={speaker.id}
                data-embed-gallery-speaker={speaker.id}
                className="rounded-xl border border-gray-200 bg-white p-3 shadow-card dark:border-gray-800 dark:bg-gray-900"
              >
                <SpeakerMonogram
                  personId={speaker.id}
                  initials={speaker.initials}
                  size="tile"
                  photoHref={speaker.photoHref}
                />
                <p data-speaker-name className="mt-2 truncate text-sm font-semibold">
                  {speaker.displayName}
                </p>
                {density === "full" && (speaker.title || speaker.company) ? (
                  <p className="mt-0.5 truncate text-xs text-gray-600 dark:text-gray-400">
                    {speaker.title ? <span data-speaker-title>{speaker.title}</span> : null}
                    {speaker.title && speaker.company ? <span aria-hidden="true"> · </span> : null}
                    {speaker.company ? <span data-speaker-company>{speaker.company}</span> : null}
                  </p>
                ) : null}
                {density === "full" ? (
                  <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-500">
                    {speaker.sessionCount} session{speaker.sessionCount === 1 ? "" : "s"}
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
        </>
      )}
    </EmbedShell>
  );
}
