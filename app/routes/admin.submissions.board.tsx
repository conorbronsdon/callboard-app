import { and, asc, eq, isNull } from "drizzle-orm";
import { redirect } from "react-router";

import { ClientOnly } from "~/components/ClientOnly";
import {
  DndSubmissionsBoard,
  SUBMISSIONS_DROP_FORM_ID,
  SubmissionsBoard,
  type SubmissionsBoardData,
  type SubmissionsBoardFeedback,
} from "~/components/submissions-board";
import { PageHeader } from "~/components/shell";
import { getDb } from "~/db/client.server";
import { sessions, tracks } from "~/db/schema";
import { requireAdmin } from "~/lib/auth/auth.server";
import { appUrl } from "~/lib/env.server";
import { currentEvent } from "~/lib/event.server";
import { applyAbstractStatus } from "~/lib/review/commit.server";
import { isAdminAssignable, STATUS_TABS, tabFor } from "~/lib/review/pipeline";
import type { Route } from "./+types/admin.submissions.board";

const PAGE = "/admin/submissions/board";
const VIEW_LINK =
  "rounded-lg px-3 py-1.5 text-sm whitespace-nowrap transition-colors";
const ACTIVE_VIEW =
  "bg-blue-100 font-semibold text-blue-800 shadow-[inset_0_-2px_0_0_var(--color-blue-600)] dark:bg-blue-950 dark:text-blue-100 dark:shadow-[inset_0_-2px_0_0_var(--color-blue-400)]";
const INACTIVE_VIEW =
  "font-medium text-gray-500 hover:bg-gray-100 hover:text-gray-900 dark:text-gray-400 dark:hover:bg-gray-800 dark:hover:text-gray-100";

export type { SubmissionsBoardData } from "~/components/submissions-board";

export function meta() {
  return [{ title: "Submissions board — callboard admin" }];
}

export async function loader({
  request,
}: Route.LoaderArgs): Promise<SubmissionsBoardData> {
  await requireAdmin(request);
  const event = await currentEvent(request);
  const notice = new URL(request.url).searchParams.get("notice");
  if (!event) return { event: null, columns: [], notice };

  const rows = await getDb()
    .select({
      id: sessions.id,
      friendlyId: sessions.friendlyId,
      title: sessions.title,
      status: sessions.status,
      trackName: tracks.name,
      trackColor: tracks.color,
    })
    .from(sessions)
    .leftJoin(tracks, eq(tracks.id, sessions.trackId))
    .where(
      and(
        eq(sessions.eventId, event.id),
        eq(sessions.isAbstract, true),
        isNull(sessions.deletedAt),
      ),
    )
    .orderBy(asc(sessions.createdAt), asc(sessions.title));

  return {
    event: { id: event.id, name: event.name },
    columns: STATUS_TABS.map((tab) => ({
      status: tab.status,
      label: tab.label,
      tone: tab.tone,
      cards: rows.filter((row) => row.status === tab.status),
    })),
    notice,
  };
}

export async function action({ request }: Route.ActionArgs) {
  await requireAdmin(request);
  const event = await currentEvent(request);
  if (!event)
    return { ok: false as const, error: "No event has been set up yet." };

  const db = getDb();
  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "");

  if (intent === "set-status") {
    const sessionId = String(formData.get("sessionId") ?? "");
    const status = String(formData.get("status") ?? "");
    if (!isAdminAssignable(status)) {
      return {
        ok: false as const,
        error: `"${status}" is not an admin-assignable status.`,
      };
    }

    const target = await db.query.sessions.findFirst({
      where: and(
        eq(sessions.id, sessionId),
        eq(sessions.eventId, event.id),
        eq(sessions.isAbstract, true),
      ),
    });
    if (!target)
      return { ok: false as const, error: "That abstract no longer exists." };

    await applyAbstractStatus({
      eventId: event.id,
      abstractId: sessionId,
      status,
      origin: appUrl(request),
      db,
    });
    const notice = `Moved abstract to ${tabFor(status).label}.`;
    return redirect(`${PAGE}?${new URLSearchParams({ notice }).toString()}`);
  }

  return { ok: false as const, error: `Unknown intent "${intent}".` };
}

type BoardActionData = Awaited<ReturnType<typeof action>> | undefined;

export function SubmissionsBoardScreen({
  data,
  actionData,
}: {
  data: SubmissionsBoardData;
  actionData?: BoardActionData;
}) {
  const feedback: SubmissionsBoardFeedback | undefined =
    actionData && !(actionData instanceof Response)
      ? actionData
      : data.notice
        ? { notice: data.notice }
        : undefined;
  return <SubmissionsBoard data={data} actionData={feedback} />;
}

export default function AdminSubmissionsBoard({
  loaderData,
  actionData,
}: Route.ComponentProps) {
  const feedback: SubmissionsBoardFeedback | undefined = actionData?.error
    ? { error: actionData.error }
    : loaderData.notice
      ? { notice: loaderData.notice }
      : undefined;

  return (
    <div className="space-y-4">
      <PageHeader
        title="Submissions board"
        description="See the full review flow and move individual abstracts through the same status path as the list view."
      />
      <nav
        aria-label="Submission views"
        className="flex flex-wrap gap-1 border-b border-gray-200 pb-2 dark:border-gray-800"
      >
        <a
          href="/admin/submissions"
          className={`${VIEW_LINK} ${INACTIVE_VIEW}`}
        >
          List
        </a>
        <a
          href={PAGE}
          aria-current="page"
          className={`${VIEW_LINK} ${ACTIVE_VIEW}`}
        >
          Board
        </a>
      </nav>
      <form method="post" id={SUBMISSIONS_DROP_FORM_ID} className="hidden">
        <input type="hidden" name="intent" value="set-status" />
        <input type="hidden" name="sessionId" value="" />
        <input type="hidden" name="status" value="" />
      </form>
      <ClientOnly
        fallback={
          <SubmissionsBoardScreen data={loaderData} actionData={actionData} />
        }
      >
        {() => <DndSubmissionsBoard data={loaderData} actionData={feedback} />}
      </ClientOnly>
    </div>
  );
}
