/**
 * Chrome-less speaker directory widget.
 *
 * Reuses `listPublicSpeakers` — the same loader helper behind
 * `/e/:slug/speakers` — so the headshot monogram, ordering by surname, and the
 * title/company line are the public directory's, not a second implementation
 * that can drift from it (EMB-16).
 */
import { EmbedShell } from "~/components/embed-shell";
import { SpeakerMonogram } from "~/components/speaker-monogram";
import { getDb } from "~/db/client.server";
import { buildEmbedXml } from "~/lib/embeds";
import { resolveEmbedOptions } from "~/lib/embeds.server";
import {
  getPublicSpeakerEvent,
  listPublicSpeakers,
  publicSpeakerPhotoHref,
} from "~/lib/public-speakers.server";
import type { Route } from "./+types/embed.speakers";

export function meta({ loaderData }: Route.MetaArgs) {
  const event = loaderData?.event?.name;
  return [{ title: event ? `Speakers — ${event}` : "Speakers — callboard" }];
}

async function loaderImpl({ params, request }: Route.LoaderArgs) {
  const url = new URL(request.url);
  const { theme, track, accent, density, format, customCss, hiddenFields } =
    await resolveEmbedOptions(params.slug, url, "speakers");

  const db = getDb();
  const event = await getPublicSpeakerEvent(db, params.slug);
  if (!event) throw new Response("Event not found", { status: 404 });

  const { speakers, total } = await listPublicSpeakers(db, event.id, "");
  const hidden = new Set(hiddenFields);
  const exportSpeakers = speakers.map((speaker) => ({
    id: speaker.id,
    name: speaker.displayName,
    ...(!hidden.has("title") ? { title: speaker.title } : {}),
    ...(!hidden.has("company") ? { company: speaker.company } : {}),
    sessionCount: speaker.sessionCount,
  }));

  if (format === "json") {
    return Response.json({
      event: { name: event.name, slug: event.slug },
      speakers: exportSpeakers,
      total,
    });
  }
  if (format === "xml") {
    return new Response(buildEmbedXml("speakers", "speaker", exportSpeakers), {
      headers: { "Content-Type": "application/xml; charset=utf-8" },
    });
  }

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
    customCss,
    hiddenFields,
  };
}

export const loader = loaderImpl as (
  args: Route.LoaderArgs,
) => Promise<Exclude<Awaited<ReturnType<typeof loaderImpl>>, Response>>;

export default function EmbedSpeakers({ loaderData }: Route.ComponentProps) {
  const { event, speakers, total, theme, accent, density, customCss, hiddenFields } =
    loaderData;
  const showTitle = !hiddenFields.includes("title");
  const showCompany = !hiddenFields.includes("company");

  return (
    <EmbedShell
      theme={theme}
      accent={accent}
      density={density}
      customCss={customCss}
      eyebrow="Speakers"
      title={event.name}
      testId="embed-speakers"
      sourceHref={`/e/${event.slug}/speakers`}
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
          <p className="mb-3 text-xs text-gray-600 dark:text-gray-400">
            {total} speaker{total === 1 ? "" : "s"}
          </p>
          <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {speakers.map((speaker) => (
              <li
                key={speaker.id}
                data-embed-speaker={speaker.id}
                className="flex items-center gap-3 rounded-xl border border-gray-200 bg-white p-3 shadow-card dark:border-gray-800 dark:bg-gray-900"
              >
                <SpeakerMonogram
                  personId={speaker.id}
                  initials={speaker.initials}
                  photoHref={speaker.photoHref}
                />
                <div className="min-w-0">
                  <p data-speaker-name className="truncate text-sm font-semibold">
                    {speaker.displayName}
                  </p>
                  {density === "full" &&
                  ((showTitle && speaker.title) || (showCompany && speaker.company)) ? (
                    <p className="mt-0.5 truncate text-xs text-gray-600 dark:text-gray-400">
                      {showTitle && speaker.title ? (
                        <span data-speaker-title>{speaker.title}</span>
                      ) : null}
                      {showTitle && speaker.title && showCompany && speaker.company ? (
                        <span aria-hidden="true"> · </span>
                      ) : null}
                      {showCompany && speaker.company ? (
                        <span data-speaker-company>{speaker.company}</span>
                      ) : null}
                    </p>
                  ) : null}
                  {density === "full" ? (
                    <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-500">
                      {speaker.sessionCount} session{speaker.sessionCount === 1 ? "" : "s"}
                    </p>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
    </EmbedShell>
  );
}
