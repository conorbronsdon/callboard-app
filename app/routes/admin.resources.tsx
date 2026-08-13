import { and, asc, desc, eq, ne } from "drizzle-orm";
import { redirect } from "react-router";

import { buttonClass } from "~/components/portal-ui";
import { getDb } from "~/db/client.server";
import { resources } from "~/db/schema";
import { requireAdmin } from "~/lib/auth/auth.server";
import { currentEvent } from "~/lib/event.server";
import { renderMarkdown } from "~/lib/markdown";
import { sanitizeHtml } from "~/lib/sanitize-html";
import type { Route } from "./+types/admin.resources";

const PAGE = "/admin/resources";
const FIELD =
  "w-full rounded border border-gray-300 px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-900";
const BUTTON = buttonClass("primary");
const GHOST = buttonClass("secondary");

function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80)
    .replace(/-+$/g, "");
}

function requiredText(form: FormData, key: string): string {
  return String(form.get(key) ?? "").trim();
}

function editableContent(form: FormData, key: string): string | null {
  const value = String(form.get(key) ?? "");
  return value.trim() ? value : null;
}

function error(message: string) {
  return { ok: false as const, error: message };
}

export async function loader({ request }: Route.LoaderArgs) {
  await requireAdmin(request);
  const event = await currentEvent(request);
  if (!event) return { event: null, pages: [] };

  const rows = await getDb()
    .select()
    .from(resources)
    .where(eq(resources.eventId, event.id))
    .orderBy(asc(resources.order), asc(resources.createdAt));

  return {
    event: { id: event.id, name: event.name },
    pages: rows.map((page) => {
      const embed = page.htmlEmbed ? sanitizeHtml(page.htmlEmbed) : null;
      return {
        id: page.id,
        slug: page.slug,
        title: page.title,
        body: page.body ?? "",
        htmlEmbed: page.htmlEmbed ?? "",
        isPublished: page.isPublished,
        order: page.order,
        preview: {
          bodyHtml: renderMarkdown(page.body),
          embedHtml: embed?.html ?? "",
          removed: embed?.removed ?? [],
        },
      };
    }),
  };
}

async function resourceInEvent(eventId: string, resourceId: string) {
  return getDb().query.resources.findFirst({
    where: and(eq(resources.id, resourceId), eq(resources.eventId, eventId)),
  });
}

async function slugIsAvailable(eventId: string, slug: string, exceptId?: string) {
  const duplicate = await getDb().query.resources.findFirst({
    where: and(
      eq(resources.eventId, eventId),
      eq(resources.slug, slug),
      ...(exceptId ? [ne(resources.id, exceptId)] : []),
    ),
  });
  return !duplicate;
}

export async function action({ request }: Route.ActionArgs) {
  await requireAdmin(request);
  const event = await currentEvent(request);
  if (!event) return error("Create an event before adding resources.");

  const db = getDb();
  const form = await request.formData();
  const intent = requiredText(form, "intent");

  if (intent === "create") {
    const title = requiredText(form, "title");
    const slug = slugify(requiredText(form, "slug") || title);
    const body = editableContent(form, "body");
    const htmlEmbed = editableContent(form, "htmlEmbed");

    if (!title || title.length > 120) {
      return error("A title is required and must be 120 characters or fewer.");
    }
    if (!slug) return error("Enter a title or URL slug with at least one letter or number.");
    if (body && body.length > 100_000) return error("Markdown content is capped at 100,000 characters.");
    if (htmlEmbed && htmlEmbed.length > 100_000) {
      return error("HTML embeds are capped at 100,000 characters.");
    }
    if (!(await slugIsAvailable(event.id, slug))) {
      return error("Another resource in this event already uses that URL slug.");
    }

    const last = await db
      .select({ order: resources.order })
      .from(resources)
      .where(eq(resources.eventId, event.id))
      .orderBy(desc(resources.order))
      .limit(1);

    await db.insert(resources).values({
      id: crypto.randomUUID(),
      eventId: event.id,
      title,
      slug,
      body,
      htmlEmbed,
      isPublished: form.get("publish") === "true",
      order: (last[0]?.order ?? -1) + 1,
    });
    return redirect(PAGE);
  }

  const resourceId = requiredText(form, "resourceId");
  const page = await resourceInEvent(event.id, resourceId);
  if (!page) return error("That resource does not belong to this event.");

  if (intent === "save") {
    const title = requiredText(form, "title");
    const slug = slugify(requiredText(form, "slug"));
    const body = editableContent(form, "body");
    const htmlEmbed = editableContent(form, "htmlEmbed");

    if (!title || title.length > 120) {
      return error("A title is required and must be 120 characters or fewer.");
    }
    if (!slug) return error("A URL slug needs at least one letter or number.");
    if (body && body.length > 100_000) return error("Markdown content is capped at 100,000 characters.");
    if (htmlEmbed && htmlEmbed.length > 100_000) {
      return error("HTML embeds are capped at 100,000 characters.");
    }
    if (!(await slugIsAvailable(event.id, slug, page.id))) {
      return error("Another resource in this event already uses that URL slug.");
    }

    await db
      .update(resources)
      .set({ title, slug, body, htmlEmbed, updatedAt: new Date() })
      .where(and(eq(resources.id, page.id), eq(resources.eventId, event.id)));
    return redirect(PAGE);
  }

  if (intent === "publish") {
    await db
      .update(resources)
      .set({ isPublished: true, updatedAt: new Date() })
      .where(and(eq(resources.id, page.id), eq(resources.eventId, event.id)));
    return redirect(PAGE);
  }

  if (intent === "archive") {
    await db
      .update(resources)
      .set({ isPublished: false, updatedAt: new Date() })
      .where(and(eq(resources.id, page.id), eq(resources.eventId, event.id)));
    return redirect(PAGE);
  }

  if (intent === "move-up" || intent === "move-down") {
    const ordered = await db
      .select({ id: resources.id, order: resources.order })
      .from(resources)
      .where(eq(resources.eventId, event.id))
      .orderBy(asc(resources.order), asc(resources.createdAt));
    const index = ordered.findIndex((row) => row.id === page.id);
    const neighborIndex = intent === "move-up" ? index - 1 : index + 1;
    const neighbor = ordered[neighborIndex];

    if (index >= 0 && neighbor) {
      const pageOrder = page.order;
      await db.batch([
        db
          .update(resources)
          .set({ order: neighbor.order, updatedAt: new Date() })
          .where(and(eq(resources.id, page.id), eq(resources.eventId, event.id))),
        db
          .update(resources)
          .set({ order: pageOrder, updatedAt: new Date() })
          .where(and(eq(resources.id, neighbor.id), eq(resources.eventId, event.id))),
      ]);
    }
    return redirect(PAGE);
  }

  return error(`Unknown intent "${intent}".`);
}

type ResourcesData = Awaited<ReturnType<typeof loader>>;

export function ResourcesView({
  event,
  pages,
  actionError,
}: ResourcesData & { actionError?: string }) {
  if (!event) {
    return (
      <section data-testid="resources-empty-event" className="rounded-xl border border-gray-200 p-6">
        <h1 className="text-xl font-semibold">Speaker resources</h1>
        <p className="mt-2 text-sm text-gray-500">Create an event in Settings before adding resources.</p>
      </section>
    );
  }

  return (
    <div data-testid="admin-resources" className="space-y-6">
      <header>
        <h1 className="text-xl font-semibold">Speaker resources</h1>
        <p className="mt-1 text-sm text-gray-500">
          Build the handbook for {event.name}. Archived pages stay editable here and disappear from the speaker portal.
        </p>
      </header>

      {actionError ? (
        <p role="alert" className="rounded-lg bg-red-50 px-4 py-3 text-sm text-red-800 dark:bg-red-950 dark:text-red-200">
          {actionError}
        </p>
      ) : null}

      <section className="rounded-xl border border-gray-200 p-5 dark:border-gray-800">
        <h2 className="font-semibold">Add a resource</h2>
        <form method="post" className="mt-4 grid gap-3">
          <input type="hidden" name="intent" value="create" />
          <label className="grid gap-1 text-sm">
            Title
            <input className={FIELD} name="title" required maxLength={120} placeholder="Speaker handbook" />
          </label>
          <label className="grid gap-1 text-sm">
            URL slug <span className="text-xs text-gray-500">Optional — generated from the title</span>
            <input className={FIELD} name="slug" maxLength={80} placeholder="speaker-handbook" />
          </label>
          <label className="grid gap-1 text-sm">
            Markdown
            <textarea className={FIELD} name="body" rows={5} placeholder="## Before you arrive" />
          </label>
          <label className="grid gap-1 text-sm">
            HTML embed <span className="text-xs text-gray-500">Sanitized every time speakers view it</span>
            <textarea className={FIELD} name="htmlEmbed" rows={4} placeholder={'<iframe src="https://…"></iframe>'} />
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" name="publish" value="true" />
            Publish immediately
          </label>
          <div><button className={BUTTON} type="submit">Create resource</button></div>
        </form>
      </section>

      {pages.length === 0 ? (
        <section data-testid="resources-zero" className="rounded-xl border border-dashed border-gray-300 p-8 text-center dark:border-gray-700">
          <h2 className="font-medium">No resource pages yet</h2>
          <p className="mt-1 text-sm text-gray-500">Add the first page above. It remains private until you publish it.</p>
        </section>
      ) : (
        <ol className="space-y-5">
          {pages.map((page, index) => (
            <li key={page.id} className="rounded-xl border border-gray-200 p-5 dark:border-gray-800">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <p className="text-xs font-medium uppercase tracking-wide text-gray-500">
                    {page.isPublished ? "Published" : "Archived / private"} · Position {index + 1}
                  </p>
                  <h2 className="font-semibold">{page.title}</h2>
                </div>
                <div className="flex flex-wrap gap-2">
                  <form method="post">
                    <input type="hidden" name="intent" value="move-up" />
                    <input type="hidden" name="resourceId" value={page.id} />
                    <button className={GHOST} type="submit" disabled={index === 0} aria-label={`Move ${page.title} up`}>↑ Up</button>
                  </form>
                  <form method="post">
                    <input type="hidden" name="intent" value="move-down" />
                    <input type="hidden" name="resourceId" value={page.id} />
                    <button className={GHOST} type="submit" disabled={index === pages.length - 1} aria-label={`Move ${page.title} down`}>↓ Down</button>
                  </form>
                  <form method="post">
                    <input type="hidden" name="intent" value={page.isPublished ? "archive" : "publish"} />
                    <input type="hidden" name="resourceId" value={page.id} />
                    <button className={page.isPublished ? GHOST : BUTTON} type="submit">
                      {page.isPublished ? "Archive" : "Publish"}
                    </button>
                  </form>
                </div>
              </div>

              <form method="post" className="mt-4 grid gap-3">
                <input type="hidden" name="intent" value="save" />
                <input type="hidden" name="resourceId" value={page.id} />
                <div className="grid gap-3 sm:grid-cols-2">
                  <label className="grid gap-1 text-sm">
                    Title
                    <input className={FIELD} name="title" required maxLength={120} defaultValue={page.title} />
                  </label>
                  <label className="grid gap-1 text-sm">
                    URL slug
                    <input className={FIELD} name="slug" required maxLength={80} defaultValue={page.slug} />
                  </label>
                </div>
                <label className="grid gap-1 text-sm">
                  Markdown
                  <textarea className={FIELD} name="body" rows={6} defaultValue={page.body} />
                </label>
                <label className="grid gap-1 text-sm">
                  HTML embed
                  <textarea className={FIELD} name="htmlEmbed" rows={4} defaultValue={page.htmlEmbed} />
                </label>
                <div><button className={BUTTON} type="submit">Save changes</button></div>
              </form>

              <details className="mt-4 rounded-lg bg-gray-50 p-4 dark:bg-gray-950">
                <summary className="cursor-pointer text-sm font-medium">Sanitized speaker preview</summary>
                <div data-testid={`resource-preview-${page.id}`} className="mt-3 space-y-3">
                  {page.preview.bodyHtml ? (
                    <div className="prose-portal text-sm" dangerouslySetInnerHTML={{ __html: page.preview.bodyHtml }} />
                  ) : <p className="text-sm text-gray-500">No Markdown content.</p>}
                  {page.preview.embedHtml ? (
                    <div className="overflow-x-auto text-sm" dangerouslySetInnerHTML={{ __html: page.preview.embedHtml }} />
                  ) : page.htmlEmbed ? (
                    <p className="text-sm text-gray-500">Nothing in this embed survived sanitizing.</p>
                  ) : null}
                  {page.preview.removed.length ? (
                    <p className="text-xs text-amber-700">
                      Removed for speaker safety: {page.preview.removed.join(", ")}
                    </p>
                  ) : null}
                </div>
              </details>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

export default function AdminResources({ loaderData, actionData }: Route.ComponentProps) {
  return <ResourcesView {...loaderData} actionError={actionData?.error} />;
}
