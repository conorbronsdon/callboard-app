/**
 * The abstract review pipeline: one seven-column board with two renderings.
 *
 * `SubmissionsBoard` is the server-rendered, no-JavaScript board. Its cards
 * retain the status select and Move button. `DndSubmissionsBoard` adds drag and
 * drop on the client, but submits the same `intent=set-status` form fields.
 */
import {
  DndContext,
  PointerSensor,
  rectIntersection,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import type { DragEndEvent } from "@dnd-kit/core";

import { buttonClass, inputClass } from "~/components/portal-ui";
import { eyebrowClass, linkClass, TrackChip } from "~/components/shell";
import type { SessionStatus } from "~/db/schema";
import {
  ADMIN_ASSIGNABLE_STATUSES,
  isAdminAssignable,
  tabFor,
} from "~/lib/review/pipeline";
import { detailUrl } from "~/routes/admin.submission";

export const SUBMISSIONS_DROP_FORM_ID = "submissions-drop-form";

export interface SubmissionsBoardCard {
  id: string;
  friendlyId: string | null;
  title: string;
  status: SessionStatus;
  trackName: string | null;
  trackColor: string | null;
}

export interface SubmissionsBoardData {
  event: { id: string; name: string } | null;
  columns: {
    status: SessionStatus;
    label: string;
    tone: string;
    cards: SubmissionsBoardCard[];
  }[];
  notice?: string | null;
}

export interface SubmissionsBoardFeedback {
  error?: string;
  notice?: string;
}

/** Convert a dnd target into the exact fields accepted by the route action. */
export function submissionDropIntent(
  sessionId: string,
  overId: unknown,
  validStages: readonly string[],
): { intent: "set-status"; sessionId: string; status: string } | null {
  if (
    !sessionId.trim() ||
    typeof overId !== "string" ||
    !validStages.includes(overId)
  ) {
    return null;
  }
  return { intent: "set-status", sessionId, status: overId };
}

function CardContent({ card }: { card: SubmissionsBoardCard }) {
  const assignableCurrentStatus = isAdminAssignable(card.status);

  return (
    <>
      <p className={eyebrowClass}>{card.friendlyId ?? "No ID"}</p>
      <a className={linkClass} href={detailUrl(card.id, card.status, null)}>
        {card.title}
      </a>
      {card.trackName ? (
        <div className="mt-2">
          <TrackChip name={card.trackName} color={card.trackColor} />
        </div>
      ) : null}
      <form method="post" className="mt-3 space-y-2">
        <input type="hidden" name="intent" value="set-status" />
        <input type="hidden" name="sessionId" value={card.id} />
        <label className="sr-only" htmlFor={`submission-status-${card.id}`}>
          Status for {card.title}
        </label>
        <select
          id={`submission-status-${card.id}`}
          name="status"
          defaultValue={assignableCurrentStatus ? card.status : ""}
          className={inputClass}
        >
          {!assignableCurrentStatus ? (
            <option value="">Choose status</option>
          ) : null}
          {ADMIN_ASSIGNABLE_STATUSES.map((status) => (
            <option key={status} value={status}>
              {tabFor(status).label}
            </option>
          ))}
        </select>
        <button type="submit" className={buttonClass("secondary", "sm")}>
          Move
        </button>
      </form>
    </>
  );
}

function PlainCard({ card }: { card: SubmissionsBoardCard }) {
  return (
    <article className="rounded-lg border border-gray-200 bg-white p-3 dark:border-gray-700 dark:bg-gray-950">
      <CardContent card={card} />
    </article>
  );
}

function DraggableCard({ card }: { card: SubmissionsBoardCard }) {
  const { attributes, listeners, setNodeRef, transform, isDragging } =
    useDraggable({
      id: card.id,
    });

  return (
    <article
      ref={setNodeRef}
      className={`cursor-grab touch-none rounded-lg border border-gray-200 bg-white p-3 dark:border-gray-700 dark:bg-gray-950 ${
        isDragging ? "opacity-40" : ""
      }`}
      style={
        transform
          ? {
              transform: `translate3d(${transform.x}px, ${transform.y}px, 0)`,
              zIndex: 20,
            }
          : undefined
      }
      {...listeners}
      {...attributes}
    >
      <CardContent card={card} />
    </article>
  );
}

interface ColumnProps {
  column: SubmissionsBoardData["columns"][number];
  children: React.ReactNode;
}

function PlainColumn({ column, children }: ColumnProps) {
  return (
    <section
      data-testid={`submissions-board-column-${column.status}`}
      className="w-72 shrink-0 rounded-lg border border-gray-200 bg-gray-50 p-3 dark:border-gray-800 dark:bg-gray-900"
    >
      {children}
    </section>
  );
}

function DroppableColumn({ column, children }: ColumnProps) {
  const { setNodeRef, isOver } = useDroppable({ id: column.status });
  return (
    <section
      ref={setNodeRef}
      data-testid={`submissions-board-column-${column.status}`}
      className={`w-72 shrink-0 rounded-lg border border-gray-200 bg-gray-50 p-3 dark:border-gray-800 dark:bg-gray-900 ${
        isOver
          ? "border-blue-400 bg-blue-50 dark:border-blue-500 dark:bg-blue-950"
          : ""
      }`}
    >
      {children}
    </section>
  );
}

function DndColumn(props: ColumnProps) {
  return isAdminAssignable(props.column.status) ? (
    <DroppableColumn {...props} />
  ) : (
    <PlainColumn {...props} />
  );
}

interface Renderers {
  Card: (props: { card: SubmissionsBoardCard }) => React.ReactElement;
  Column: (props: ColumnProps) => React.ReactElement;
}

function BoardShell({
  data,
  actionData,
  Card,
  Column,
}: {
  data: SubmissionsBoardData;
  actionData?: SubmissionsBoardFeedback;
} & Renderers) {
  return (
    <div className="space-y-4" data-testid="submissions-board">
      <header>
        <h2 className="text-xl font-semibold">Review pipeline</h2>
        <p className="text-sm text-gray-500 dark:text-gray-400">
          See every abstract at once and move it through the existing review
          statuses.
        </p>
      </header>
      {actionData?.error ? (
        <p
          role="alert"
          className="rounded-lg bg-rose-50 p-3 text-sm text-rose-800 dark:bg-rose-950 dark:text-rose-200"
        >
          {actionData.error}
        </p>
      ) : null}
      {actionData?.notice ? (
        <p
          role="status"
          className="rounded-lg bg-green-50 p-3 text-sm text-green-800 dark:bg-green-950 dark:text-green-200"
        >
          {actionData.notice}
        </p>
      ) : null}
      {data.columns.length ? (
        <div className="overflow-x-auto pb-2">
          <div className="flex min-w-max gap-4">
            {data.columns.map((column) => (
              <Column key={column.status} column={column}>
                <div className="flex items-center justify-between gap-2">
                  <h3 className="font-semibold">{column.label}</h3>
                  <span
                    className={`rounded-full px-2 py-0.5 text-xs ${column.tone}`}
                  >
                    {column.cards.length}
                  </span>
                </div>
                {column.cards.length ? (
                  <div className="mt-3 space-y-3">
                    {column.cards.map((card) => (
                      <Card key={card.id} card={card} />
                    ))}
                  </div>
                ) : (
                  <p className="mt-3 text-sm text-gray-500 dark:text-gray-400">
                    {isAdminAssignable(column.status)
                      ? "No abstracts in this status. Drag a card here, or choose this status on a card and press Move."
                      : "No abstracts in this system-controlled status."}
                  </p>
                )}
              </Column>
            ))}
          </div>
        </div>
      ) : (
        <p className="rounded-lg border border-dashed border-gray-300 p-4 text-sm text-gray-600 dark:border-gray-700 dark:text-gray-300">
          Create an event before reviewing submissions.
        </p>
      )}
    </div>
  );
}

/** SSR / no-JavaScript rendering. Identical board and forms, without drag. */
export function SubmissionsBoard({
  data,
  actionData,
}: {
  data: SubmissionsBoardData;
  actionData?: SubmissionsBoardFeedback;
}) {
  return (
    <BoardShell
      data={data}
      actionData={actionData}
      Card={PlainCard}
      Column={PlainColumn}
    />
  );
}

/** Client-only rendering with drag-and-drop. Must live inside `<ClientOnly>`. */
export function DndSubmissionsBoard({
  data,
  actionData,
}: {
  data: SubmissionsBoardData;
  actionData?: SubmissionsBoardFeedback;
}) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
  );

  function onDragEnd(event: DragEndEvent) {
    const fields = submissionDropIntent(
      String(event.active.id),
      event.over?.id,
      ADMIN_ASSIGNABLE_STATUSES,
    );
    if (!fields) return;

    const form = document.getElementById(SUBMISSIONS_DROP_FORM_ID);
    if (!(form instanceof HTMLFormElement)) return;

    for (const [name, value] of Object.entries(fields)) {
      const field = form.elements.namedItem(name);
      if (field instanceof HTMLInputElement) field.value = value;
    }
    form.requestSubmit();
  }

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={rectIntersection}
      onDragEnd={onDragEnd}
    >
      <BoardShell
        data={data}
        actionData={actionData}
        Card={DraggableCard}
        Column={DndColumn}
      />
    </DndContext>
  );
}
