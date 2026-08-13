import { buttonClass, inputClass } from "~/components/portal-ui";
import { linkClass } from "~/components/shell";
import { requireAdmin } from "~/lib/auth/auth.server";
import {
  EMBED_FORMATS,
  EMBED_WIDGETS,
  buildEmbedUrl,
  buildFeedUrl,
  buildSnippet,
  getEmbedWidget,
  isEmbedDensity,
  isEmbedFormat,
  isEmbedWidgetId,
  parseAccent,
  parseDensity,
  parseFormat,
  parseTheme,
  removeSavedEmbed,
  resolveTrackRef,
  toTrackRef,
  toggleSavedEmbed,
  upsertSavedEmbed,
  type EmbedTheme,
} from "~/lib/embeds";
import {
  listEmbedTracks,
  loadEventEmbedSettings,
  writeEventEmbedSettings,
} from "~/lib/embeds.server";
import { requireCurrentEvent } from "~/lib/event.server";
import type { Route } from "./+types/admin.embeds";

export function meta() {
  return [{ title: "Embeds — callboard admin" }];
}

export async function loader({ request }: Route.LoaderArgs) {
  await requireAdmin(request);
  const event = await requireCurrentEvent(request);
  const [tracks, embedState] = await Promise.all([
    listEmbedTracks(event.id),
    loadEventEmbedSettings(event.id),
  ]);
  const url = new URL(request.url);
  const requestedWidget = url.searchParams.get("w") ?? "schedule";
  const selectedWidget = isEmbedWidgetId(requestedWidget) ? requestedWidget : "schedule";

  return {
    event: { id: event.id, name: event.name, slug: event.slug },
    origin: url.origin,
    tracks,
    savedEmbeds: embedState.embeds,
    selectedWidget,
    selectedTheme: parseTheme(url.searchParams.get("theme")),
    selectedTrack: url.searchParams.get("track")?.trim() || null,
    selectedFormat: parseFormat(url.searchParams.get("format")),
    selectedDensity: parseDensity(url.searchParams.get("density")),
    selectedAccent: parseAccent(url.searchParams.get("accent")),
    showSnippet: url.searchParams.has("w") && isEmbedWidgetId(requestedWidget),
  };
}

function isTheme(value: string): value is EmbedTheme {
  return value === "light" || value === "dark" || value === "auto";
}

export async function action({ request }: Route.ActionArgs) {
  await requireAdmin(request);
  const event = await requireCurrentEvent(request);
  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "");
  const state = await loadEventEmbedSettings(event.id);

  if (intent === "save") {
    const name = String(formData.get("name") ?? "").trim();
    const widget = String(formData.get("widget") ?? "");
    const theme = String(formData.get("theme") ?? "");
    // Stored by ID, not by name: a saved embed outlives a track rename, and it
    // lives on a page we cannot re-edit. Server-side, because the picker posts
    // the name the organizer saw.
    const track = toTrackRef(String(formData.get("track") ?? ""), await listEmbedTracks(event.id));
    const format = String(formData.get("format") ?? "");
    const density = String(formData.get("density") ?? "");
    const accentValue = String(formData.get("accent") ?? "").trim();
    const accent = parseAccent(accentValue);

    if (!name) return { ok: false as const, error: "Name is required." };
    if (name.length > 80) {
      return { ok: false as const, error: "Name must be 80 characters or fewer." };
    }
    if (!isEmbedWidgetId(widget)) {
      return { ok: false as const, error: "Unknown embed widget." };
    }
    if (!isTheme(theme)) {
      return { ok: false as const, error: "Unknown embed theme." };
    }
    if (!isEmbedFormat(format)) {
      return { ok: false as const, error: "Unknown embed format." };
    }
    if (!isEmbedDensity(density)) {
      return { ok: false as const, error: "Unknown embed density." };
    }
    if (accentValue && !accent) {
      return { ok: false as const, error: "Accent must be a hex colour like #0f766e." };
    }

    const settings = upsertSavedEmbed(state.settings, {
      id: crypto.randomUUID(),
      name,
      widget,
      theme,
      track,
      format,
      density,
      accent,
      enabled: true,
      createdAt: Date.now(),
    });
    await writeEventEmbedSettings(event.id, settings);
    return { ok: true as const, error: null, message: `Saved “${name}”.` };
  }

  if (intent === "toggle" || intent === "delete") {
    const id = String(formData.get("id") ?? "");
    const result =
      intent === "toggle"
        ? toggleSavedEmbed(state.settings, id)
        : removeSavedEmbed(state.settings, id);
    if (!result.found) {
      return { ok: false as const, error: "Saved embed not found." };
    }
    await writeEventEmbedSettings(event.id, result.settings);
    return {
      ok: true as const,
      error: null,
      message: intent === "toggle" ? "Embed state updated." : "Embed removed.",
    };
  }

  return { ok: false as const, error: "Unknown embed action." };
}

/*
 * The snippet box is not a form field: it is a read-only code well carrying
 * `font-mono text-xs`, which would lose a `text-sm` fight against `inputClass`
 * — Tailwind resolves conflicting utilities by stylesheet order, not by the
 * order they appear in the class attribute. So it keeps its own string, and the
 * three real inputs moved to the shared one.
 */
const SNIPPET_CLASS =
  "w-full rounded-lg border border-gray-300 bg-white px-3 py-2 dark:border-gray-700 dark:bg-gray-950";

function CopyButton({ textareaId, label }: { textareaId: string; label: string }) {
  function selectFallback(textarea: HTMLTextAreaElement) {
    textarea.focus();
    textarea.select();
    textarea.setSelectionRange(0, textarea.value.length);
  }

  function copy() {
    const textarea = document.getElementById(textareaId);
    if (!(textarea instanceof HTMLTextAreaElement)) return;
    if (typeof navigator !== "undefined" && navigator.clipboard) {
      void navigator.clipboard.writeText(textarea.value).catch(() => selectFallback(textarea));
    } else {
      selectFallback(textarea);
    }
  }

  return (
    <button
      type="button"
      onClick={copy}
      aria-label={label}
      className={buttonClass("secondary")}
    >
      Copy
    </button>
  );
}

function SnippetField({
  id,
  testId,
  snippet,
  ariaLabel,
}: {
  id: string;
  testId: string;
  snippet: string;
  ariaLabel: string;
}) {
  return (
    <div className="flex flex-col items-start gap-2 sm:flex-row">
      <textarea
        id={id}
        data-testid={testId}
        aria-label={ariaLabel}
        readOnly
        rows={4}
        spellCheck={false}
        value={snippet}
        className={`${SNIPPET_CLASS} min-h-24 flex-1 font-mono text-xs`}
      />
      <CopyButton textareaId={id} label={`Copy ${ariaLabel.toLowerCase()}`} />
    </div>
  );
}

export default function AdminEmbeds({ loaderData, actionData }: Route.ComponentProps) {
  const {
    event,
    origin,
    tracks,
    savedEmbeds,
    selectedWidget,
    selectedTheme,
    selectedTrack,
    selectedFormat,
    selectedDensity,
    selectedAccent,
    showSnippet,
  } = loaderData;

  return (
    <div className="space-y-8">
      <div>
        <h2 className="text-2xl font-semibold tracking-tight">Embeds</h2>
        <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
          Publish live callboard widgets on another website. Saved embed links keep working when
          their configuration changes.
        </p>
      </div>

      {actionData?.error ? (
        <p className="rounded-lg border border-red-300 bg-red-50 p-3 text-sm text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-200">
          {actionData.error}
        </p>
      ) : null}
      {actionData?.ok ? (
        <p className="rounded-lg border border-green-300 bg-green-50 p-3 text-sm text-green-700 dark:border-green-900 dark:bg-green-950 dark:text-green-200">
          {actionData.message}
        </p>
      ) : null}

      <div className="grid gap-5">
        {EMBED_WIDGETS.map((widget) => {
          const active = selectedWidget === widget.id;
          const theme = active ? selectedTheme : "auto";
          const track = active ? selectedTrack : null;
          const format = active ? selectedFormat : "iframe";
          const density = active ? selectedDensity : "full";
          const accent = active ? selectedAccent : null;
          const embedUrl = buildEmbedUrl({
            origin,
            slug: event.slug,
            widget: widget.id,
            theme,
            track,
            density,
            accent,
          });
          const feedUrl = buildFeedUrl({ origin, slug: event.slug, widget: widget.id });
          const snippet = buildSnippet({
            format,
            url: embedUrl,
            feedUrl,
            eventName: event.name,
            widgetLabel: widget.label,
          });

          return (
            <section
              key={widget.id}
              className="rounded-xl border border-gray-200 bg-white p-5 shadow-card dark:border-gray-800 dark:bg-gray-900"
            >
              <h3 className="text-lg font-semibold">{widget.label}</h3>
              <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
                {widget.description}
              </p>

              <form method="get" className="mt-5 grid gap-4 sm:grid-cols-2">
                <input type="hidden" name="w" value={widget.id} />
                <div>
                  <label
                    htmlFor={`embed-theme-${widget.id}`}
                    className="block text-sm font-medium"
                  >
                    Theme
                  </label>
                  <select
                    id={`embed-theme-${widget.id}`}
                    name="theme"
                    aria-label={`Theme for ${widget.label}`}
                    defaultValue={theme}
                    className={inputClass}
                  >
                    <option value="light">Light</option>
                    <option value="dark">Dark</option>
                    <option value="auto">Auto</option>
                  </select>
                </div>
                {widget.supportsTrackFilter ? (
                  <div>
                    <label
                      htmlFor={`embed-track-${widget.id}`}
                      className="block text-sm font-medium"
                    >
                      Track
                    </label>
                    <select
                      id={`embed-track-${widget.id}`}
                      name="track"
                      aria-label={`Track for ${widget.label}`}
                      defaultValue={track ?? ""}
                      className={inputClass}
                    >
                      <option value="">All tracks</option>
                      {tracks.map((option) => (
                        <option key={option.id} value={option.name}>
                          {option.name}
                        </option>
                      ))}
                    </select>
                  </div>
                ) : null}
                <div>
                  <label
                    htmlFor={`embed-format-${widget.id}`}
                    className="mb-1 block text-sm font-medium"
                  >
                    Format
                  </label>
                  <select
                    id={`embed-format-${widget.id}`}
                    name="format"
                    aria-label={`Format for ${widget.label}`}
                    defaultValue={format}
                    className={inputClass}
                  >
                    {EMBED_FORMATS.filter(
                      (option) => option.id !== "ical" || widget.feedPath !== null,
                    ).map((option) => (
                      <option key={option.id} value={option.id}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label
                    htmlFor={`embed-density-${widget.id}`}
                    className="mb-1 block text-sm font-medium"
                  >
                    Density
                  </label>
                  <select
                    id={`embed-density-${widget.id}`}
                    name="density"
                    aria-label={`Density for ${widget.label}`}
                    defaultValue={density}
                    className={inputClass}
                  >
                    <option value="full">Full</option>
                    <option value="compact">Compact</option>
                  </select>
                </div>
                <div>
                  <label
                    htmlFor={`embed-accent-${widget.id}`}
                    className="mb-1 block text-sm font-medium"
                  >
                    Accent colour
                  </label>
                  <input
                    id={`embed-accent-${widget.id}`}
                    type="text"
                    name="accent"
                    aria-label={`Accent colour for ${widget.label}`}
                    placeholder="#0f766e"
                    maxLength={7}
                    defaultValue={accent ?? ""}
                    className={inputClass}
                  />
                </div>
                <div className="sm:col-span-2">
                  <button
                    type="submit"
                    aria-label={`Get Code for ${widget.label}`}
                    className={buttonClass("primary")}
                  >
                    Get Code
                  </button>
                </div>
              </form>

              <div className="mt-5">
                <p className="text-sm font-medium">Embed URL</p>
                <a
                  href={embedUrl}
                  target="_blank"
                  rel="noopener"
                  className={`${linkClass} mt-1 block break-all font-mono text-xs`}
                >
                  {embedUrl}
                </a>
              </div>

              {feedUrl ? (
                <div className="mt-3">
                  <p className="text-sm font-medium">Calendar feed (iCal)</p>
                  <a
                    href={feedUrl}
                    target="_blank"
                    rel="noopener"
                    className={`${linkClass} mt-1 block break-all font-mono text-xs`}
                  >
                    {feedUrl}
                  </a>
                </div>
              ) : null}

              {showSnippet && active ? (
                <div className="mt-4">
                  <p className="mb-1 text-sm font-medium">Embed code</p>
                  <SnippetField
                    id={`embed-snippet-${widget.id}`}
                    testId={`embed-snippet-${widget.id}`}
                    snippet={snippet}
                    ariaLabel={`Embed code for ${widget.label}`}
                  />
                </div>
              ) : null}

              <form method="post" className="mt-5 flex flex-col gap-3 sm:flex-row sm:items-end">
                <input type="hidden" name="intent" value="save" />
                <input type="hidden" name="widget" value={widget.id} />
                <input type="hidden" name="theme" value={theme} />
                <input type="hidden" name="track" value={track ?? ""} />
                <input type="hidden" name="format" value={format} />
                <input type="hidden" name="density" value={density} />
                <input type="hidden" name="accent" value={accent ?? ""} />
                <div className="min-w-0 flex-1">
                  <label
                    htmlFor={`embed-name-${widget.id}`}
                    className="block text-sm font-medium"
                  >
                    Name
                  </label>
                  <input
                    id={`embed-name-${widget.id}`}
                    name="name"
                    aria-label={`Name for ${widget.label}`}
                    required
                    maxLength={80}
                    className={inputClass}
                  />
                </div>
                <button
                  type="submit"
                  aria-label={`Save this embed for ${widget.label}`}
                  className={buttonClass("secondary")}
                >
                  Save this embed
                </button>
              </form>
            </section>
          );
        })}
      </div>

      <section>
        <h2 className="text-xl font-semibold tracking-tight">Saved embeds</h2>
        <div data-testid="saved-embeds" className="mt-3 space-y-3">
          {savedEmbeds.length === 0 ? (
            <div className="rounded-xl border border-dashed border-gray-300 bg-white/60 p-6 text-sm text-gray-600 dark:border-gray-700 dark:bg-gray-900/40 dark:text-gray-300">
              <p className="font-medium text-gray-900 dark:text-gray-100">
                No saved embeds yet
              </p>
              <p className="mt-1">Configure a widget above and save it for a stable live link.</p>
            </div>
          ) : (
            savedEmbeds.map((embed) => {
              const widget = getEmbedWidget(embed.widget);
              const embedUrl = buildEmbedUrl({
                origin,
                slug: event.slug,
                widget: embed.widget,
                embedId: embed.id,
              });
              const feedUrl = buildFeedUrl({
                origin,
                slug: event.slug,
                widget: embed.widget,
              });
              const snippet = buildSnippet({
                format: embed.format,
                url: embedUrl,
                feedUrl,
                eventName: event.name,
                widgetLabel: widget.label,
              });
              return (
                <article
                  key={embed.id}
                  data-saved-embed={embed.id}
                  className="rounded-xl border border-gray-200 bg-white p-5 shadow-card dark:border-gray-800 dark:bg-gray-900"
                >
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <h3 className="font-semibold">{embed.name}</h3>
                      <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
                        {widget.label} · {embed.theme} ·{" "}
                        {resolveTrackRef(embed.track, tracks) ?? "All tracks"} · {embed.format} ·{" "}
                        {embed.density} · {embed.accent ?? "No accent"}
                      </p>
                    </div>
                    <span
                      className={`rounded-full px-2.5 py-1 text-xs font-semibold ${embed.enabled ? "bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-200" : "bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300"}`}
                    >
                      {embed.enabled ? "Enabled" : "Disabled"}
                    </span>
                  </div>
                  <a
                    href={embedUrl}
                    target="_blank"
                    rel="noopener"
                    className={`${linkClass} mt-3 block break-all font-mono text-xs`}
                  >
                    {embedUrl}
                  </a>
                  <div className="mt-3">
                    <SnippetField
                      id={`saved-embed-snippet-${embed.id}`}
                      testId="saved-embed-snippet"
                      snippet={snippet}
                      ariaLabel={`Embed code for ${embed.name}`}
                    />
                  </div>
                  <div className="mt-3 flex gap-2">
                    <form method="post">
                      <input type="hidden" name="intent" value="toggle" />
                      <input type="hidden" name="id" value={embed.id} />
                      <button
                        type="submit"
                        aria-label={`${embed.enabled ? "Disable" : "Enable"} ${embed.name}`}
                        className={buttonClass("secondary")}
                      >
                        {embed.enabled ? "Disable" : "Enable"}
                      </button>
                    </form>
                    <form method="post">
                      <input type="hidden" name="intent" value="delete" />
                      <input type="hidden" name="id" value={embed.id} />
                      <button
                        type="submit"
                        aria-label={`Remove ${embed.name}`}
                        className={buttonClass("danger")}
                      >
                        Remove
                      </button>
                    </form>
                  </div>
                </article>
              );
            })
          )}
        </div>
      </section>
    </div>
  );
}
