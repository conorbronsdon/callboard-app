/**
 * The CRM sourcing pipeline: two renderings of one five-column board.
 *
 * `PipelineBoard` is the server-rendered, no-JavaScript board. Its cards keep
 * the stage select, Move button, and Remove button, so every operation works
 * without hydration. `DndPipelineBoard` wraps the same shell in @dnd-kit and
 * makes those same cards and columns draggable/droppable.
 *
 * A drop does not create another transport. It fills the hidden form rendered
 * by the route and submits it, producing the same `intent=move`, `entryId`, and
 * `stage` fields as the per-card form and therefore reaching the same action.
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
import { linkClass } from "~/components/shell";
import type { PipelineStage } from "~/db/schema";
import type { PipelineBoardCard } from "~/lib/pipeline.server";

export const PIPELINE_DROP_FORM_ID = "pipeline-drop-form";

export interface PipelineBoardData {
  columns: {
    stage: PipelineStage;
    label: string;
    cards: PipelineBoardCard[];
  }[];
}

export interface PipelineBoardFeedback {
  error?: string;
  notice?: string;
}

/**
 * Convert a dnd target into the exact fields accepted by the existing action.
 * A valid same-stage drop still maps to an intent: `moveEntry` owns that domain
 * decision and safely no-ops it without writing an audit transition.
 */
export function pipelineDropIntent(
  entryId: string,
  overId: unknown,
  validStages: readonly string[],
): { intent: "move"; entryId: string; stage: string } | null {
  if (!entryId.trim() || typeof overId !== "string" || !validStages.includes(overId)) {
    return null;
  }
  return { intent: "move", entryId, stage: overId };
}

function CardContent({ card, data }: { card: PipelineBoardCard; data: PipelineBoardData }) {
  return (
    <>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <a className={linkClass} href={`/admin/contacts/${card.personId}`}>
            {card.fullName}
          </a>
          <p className="truncate text-sm text-gray-500 dark:text-gray-400">
            {card.company ?? "No company"}
          </p>
        </div>
        {card.score !== null ? (
          <span className="shrink-0 rounded-full bg-blue-100 px-2 py-0.5 text-xs font-medium text-blue-800 dark:bg-blue-950 dark:text-blue-200">
            {card.score}
          </span>
        ) : null}
      </div>
      <form method="post" className="mt-3 space-y-2">
        <input type="hidden" name="entryId" value={card.entryId} />
        <label className="sr-only" htmlFor={`pipeline-stage-${card.entryId}`}>
          Stage for {card.fullName}
        </label>
        <select
          id={`pipeline-stage-${card.entryId}`}
          name="stage"
          defaultValue={card.stage}
          className={inputClass}
        >
          {data.columns.map((option) => (
            <option key={option.stage} value={option.stage}>
              {option.label}
            </option>
          ))}
        </select>
        <button
          type="submit"
          name="intent"
          value="move"
          className={buttonClass("secondary", "sm")}
        >
          Move
        </button>
      </form>
      <form method="post" className="mt-2">
        <input type="hidden" name="entryId" value={card.entryId} />
        <button
          type="submit"
          name="intent"
          value="remove"
          className={buttonClass("secondary", "sm")}
          aria-label={`Remove ${card.fullName} from the sourcing pipeline`}
        >
          Remove
        </button>
      </form>
    </>
  );
}

function PlainCard({ card, data }: { card: PipelineBoardCard; data: PipelineBoardData }) {
  return (
    <article className="rounded-lg border border-gray-200 bg-white p-3 dark:border-gray-700 dark:bg-gray-950">
      <CardContent card={card} data={data} />
    </article>
  );
}

function DraggableCard({ card, data }: { card: PipelineBoardCard; data: PipelineBoardData }) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: card.entryId,
  });

  return (
    <article
      ref={setNodeRef}
      className={`rounded-lg border border-gray-200 bg-white p-3 dark:border-gray-700 dark:bg-gray-950 cursor-grab touch-none ${
        isDragging ? "opacity-40" : ""
      }`}
      style={
        transform
          ? { transform: `translate3d(${transform.x}px, ${transform.y}px, 0)`, zIndex: 20 }
          : undefined
      }
      {...listeners}
      {...attributes}
    >
      <CardContent card={card} data={data} />
    </article>
  );
}

interface ColumnProps {
  column: PipelineBoardData["columns"][number];
  children: React.ReactNode;
}

function PlainColumn({ column, children }: ColumnProps) {
  return (
    <section
      data-testid={`pipeline-column-${column.stage}`}
      className="w-72 shrink-0 rounded-lg border border-gray-200 bg-gray-50 p-3 dark:border-gray-800 dark:bg-gray-900"
    >
      {children}
    </section>
  );
}

function DroppableColumn({ column, children }: ColumnProps) {
  const { setNodeRef, isOver } = useDroppable({ id: column.stage });
  return (
    <section
      ref={setNodeRef}
      data-testid={`pipeline-column-${column.stage}`}
      className={`w-72 shrink-0 rounded-lg border border-gray-200 bg-gray-50 p-3 dark:border-gray-800 dark:bg-gray-900 ${
        isOver ? "border-blue-400 bg-blue-50 dark:border-blue-500 dark:bg-blue-950" : ""
      }`}
    >
      {children}
    </section>
  );
}

interface Renderers {
  Card: (props: { card: PipelineBoardCard; data: PipelineBoardData }) => React.ReactElement;
  Column: (props: ColumnProps) => React.ReactElement;
}

function BoardShell({
  data,
  actionData,
  Card,
  Column,
}: {
  data: PipelineBoardData;
  actionData?: PipelineBoardFeedback;
} & Renderers) {
  return (
    <div className="space-y-4" data-testid="pipeline-board">
      <header>
        <h2 className="text-xl font-semibold">Sourcing pipeline</h2>
        <p className="text-sm text-gray-500 dark:text-gray-400">
          Move organization-level contacts through a fixed five-stage workflow.
        </p>
      </header>
      {actionData && "error" in actionData ? (
        <p
          role="alert"
          className="rounded-lg bg-rose-50 p-3 text-sm text-rose-800 dark:bg-rose-950 dark:text-rose-200"
        >
          {actionData.error}
        </p>
      ) : null}
      {actionData && "notice" in actionData ? (
        <p
          role="status"
          className="rounded-lg bg-green-50 p-3 text-sm text-green-800 dark:bg-green-950 dark:text-green-200"
        >
          {actionData.notice}
        </p>
      ) : null}
      <div className="overflow-x-auto pb-2">
        <div className="flex min-w-max gap-4">
          {data.columns.map((column) => (
            <Column key={column.stage} column={column}>
              <div className="flex items-center justify-between gap-2">
                <h3 className="font-semibold">{column.label}</h3>
                <span className="rounded-full bg-gray-200 px-2 py-0.5 text-xs dark:bg-gray-800">
                  {column.cards.length}
                </span>
              </div>
              {column.cards.length ? (
                <div className="mt-3 space-y-3">
                  {column.cards.map((card) => (
                    <Card key={card.entryId} card={card} data={data} />
                  ))}
                </div>
              ) : (
                <p className="mt-3 text-sm text-gray-500 dark:text-gray-400">
                  No contacts here yet.
                </p>
              )}
            </Column>
          ))}
        </div>
      </div>
    </div>
  );
}

/** SSR / no-JavaScript rendering. Identical board and forms, without drag. */
export function PipelineBoard({
  data,
  actionData,
}: {
  data: PipelineBoardData;
  actionData?: PipelineBoardFeedback;
}) {
  return <BoardShell data={data} actionData={actionData} Card={PlainCard} Column={PlainColumn} />;
}

/** Client-only rendering with drag-and-drop. Must live inside `<ClientOnly>`. */
export function DndPipelineBoard({
  data,
  actionData,
}: {
  data: PipelineBoardData;
  actionData?: PipelineBoardFeedback;
}) {
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));
  const validStages = data.columns.map((column) => column.stage);

  function onDragEnd(event: DragEndEvent) {
    const fields = pipelineDropIntent(String(event.active.id), event.over?.id, validStages);
    if (!fields) return;

    const form = document.getElementById(PIPELINE_DROP_FORM_ID);
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
        Column={DroppableColumn}
      />
    </DndContext>
  );
}
