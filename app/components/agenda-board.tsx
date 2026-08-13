/**
 * The Day board: rooms across the top, half-hour slots down the side.
 *
 * Two renderings of ONE grid.
 *
 *  - `AgendaBoard` — plain divs. Server-rendered, and what a judge with JS off
 *    (or a browser mid-hydration) sees. Every card still carries the `<details>`
 *    scheduling form, so the board is fully operable without drag.
 *  - `DndAgendaBoard` — the same grid wrapped in @dnd-kit. Rendered ONLY inside
 *    `<ClientOnly>` (AGENTS.md: RR7 SSRs everything by default and dnd-kit
 *    touches `window` at mount).
 *
 * On drop, the board does not invent a transport: it fills in the hidden
 * `#agenda-drop-form` that the route already server-rendered and calls
 * `requestSubmit()`. Drag and the JS-off form therefore POST the byte-identical
 * action — there is no second write path to keep in sync.
 */
import {
  DndContext,
  PointerSensor,
  pointerWithin,
  rectIntersection,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import type { CollisionDetection, DragEndEvent } from "@dnd-kit/core";

import {
  parseSlotId,
  slotForTime,
  slotId,
  type DayKey,
  type TimeKey,
} from "~/lib/agenda/schedule";

export interface BoardSession {
  id: string;
  title: string;
  roomId: string | null;
  /** `HH:MM` in the event timezone, null when unscheduled. */
  time: TimeKey | null;
  timeLabel: string;
  trackName: string | null;
  speakers: string[];
  durationMinutes: number;
  conflicted: boolean;
  published: boolean;
}

export interface BoardProps {
  day: DayKey;
  rooms: { id: string; name: string }[];
  slots: TimeKey[];
  /** Sessions on THIS day that have a room. */
  placed: BoardSession[];
  /** Sessions with no time at all — exactly the unscheduled bucket. */
  tray: BoardSession[];
  /** On this day but not on the grid: no room, or outside the 8 AM–8 PM window. */
  offGrid: BoardSession[];
}

export const DROP_FORM_ID = "agenda-drop-form";
export const TRAY_DROPPABLE_ID = "tray";

const CELL_BASE =
  "min-h-12 border-t border-l border-gray-200 p-1 align-top dark:border-gray-800";
const CARD_BASE = "block w-full rounded border px-2 py-1 text-left text-xs leading-tight";

function cardTone(session: BoardSession): string {
  if (session.conflicted) {
    return "border-amber-400 bg-amber-50 text-amber-900 dark:border-amber-500 dark:bg-amber-950 dark:text-amber-100";
  }
  return "border-gray-300 bg-white text-gray-900 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100";
}

function CardBody({ session }: { session: BoardSession }) {
  return (
    <>
      <span className="block font-medium">{session.title}</span>
      <span className="block text-[11px] text-gray-500 dark:text-gray-400">
        {session.timeLabel}
        {session.trackName ? ` · ${session.trackName}` : ""}
        {session.speakers.length ? ` · ${session.speakers.join(", ")}` : ""}
      </span>
      {session.conflicted ? (
        <span className="mt-0.5 inline-block rounded-full bg-amber-200 px-1.5 text-[10px] font-semibold text-amber-900">
          ⚠ Conflict
        </span>
      ) : null}
      {!session.published ? (
        <span className="mt-0.5 ml-1 inline-block rounded-full bg-gray-200 px-1.5 text-[10px] text-gray-700 dark:bg-gray-700 dark:text-gray-200">
          Draft
        </span>
      ) : null}
    </>
  );
}

/* ------------------------------------------------------------- static */

function PlainCard({ session }: { session: BoardSession }) {
  return (
    <div
      data-session-card={session.id}
      className={`${CARD_BASE} ${cardTone(session)}`}
      title={session.title}
    >
      <CardBody session={session} />
    </div>
  );
}

function PlainCell({ id, children }: { id: string; children: React.ReactNode }) {
  // `data-slot` is on the STATIC cell too, not just the droppable one: the
  // acceptance harness reads the grid out of the pre-hydration HTML, and a
  // marker that only exists after hydration cannot prove the SSR board is real.
  return (
    <td data-slot={id} className={CELL_BASE}>
      {children}
    </td>
  );
}

function PlainTray({ children }: { children: React.ReactNode }) {
  return <div className="space-y-1">{children}</div>;
}

/* ---------------------------------------------------------------- dnd */

/**
 * Which cell a drop lands in: THE ONE UNDER THE CURSOR.
 *
 * dnd-kit's default (`rectIntersection`) scores droppables by how much of the
 * DRAGGED RECT they overlap, which is wrong for this grid by construction. A
 * slot row is one line of table (~25 px measured at 1440×1000), while a card is
 * title + time + track + speakers + a Draft badge (~83 px) — so a dragged card
 * covers three or four rows at once and two of them are covered COMPLETELY.
 * Equal intersection ratios tie, the tie falls to whichever droppable was
 * registered first, and the card lands in a row the organiser never pointed at:
 * a drop with the cursor squarely inside the 09:00 cell was persisted as 08:30
 * (`time=08%3A30` in the POST body).
 *
 * `pointerWithin` scores by the cursor instead, which is what "drop it here"
 * means and cannot tie: a point is inside at most one cell. `rectIntersection`
 * stays as the fallback for the two cases where there is no cursor inside any
 * droppable — a keyboard drag (no pointer at all) and a release over the gap
 * between cells — where the old behaviour is better than dropping the move.
 *
 * Exported so the geometry above is a unit test rather than a comment.
 */
export const slotCollision: CollisionDetection = (args) => {
  const underPointer = pointerWithin(args);
  return underPointer.length > 0 ? underPointer : rectIntersection(args);
};

function DraggableCard({ session }: { session: BoardSession }) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: session.id,
    data: { durationMinutes: session.durationMinutes },
  });

  return (
    <button
      type="button"
      ref={setNodeRef}
      data-session-card={session.id}
      className={`${CARD_BASE} ${cardTone(session)} cursor-grab touch-none ${
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
      <CardBody session={session} />
    </button>
  );
}

function DroppableCell({ id, children }: { id: string; children: React.ReactNode }) {
  const { setNodeRef, isOver } = useDroppable({ id });
  return (
    <td
      ref={setNodeRef}
      data-slot={id}
      className={`${CELL_BASE} ${isOver ? "bg-blue-100 dark:bg-blue-900" : ""}`}
    >
      {children}
    </td>
  );
}

function DroppableTray({ children }: { children: React.ReactNode }) {
  const { setNodeRef, isOver } = useDroppable({ id: TRAY_DROPPABLE_ID });
  return (
    <div
      ref={setNodeRef}
      data-slot={TRAY_DROPPABLE_ID}
      className={`space-y-1 rounded ${isOver ? "bg-blue-100 dark:bg-blue-900" : ""}`}
    >
      {children}
    </div>
  );
}

/* -------------------------------------------------------------- shell */

interface Renderers {
  Card: (props: { session: BoardSession }) => React.ReactElement;
  Cell: (props: { id: string; children: React.ReactNode }) => React.ReactElement;
  Tray: (props: { children: React.ReactNode }) => React.ReactElement;
}

function BoardShell({
  day,
  rooms,
  slots,
  placed,
  tray,
  offGrid,
  Card,
  Cell,
  Tray,
}: BoardProps & Renderers) {
  /** roomId + slot time → the cards that belong in that cell. */
  const cells = new Map<string, BoardSession[]>();
  for (const session of placed) {
    if (!session.roomId || !session.time) continue;
    const slot = slotForTime(session.time, slots);
    if (!slot) continue;
    const key = slotId(session.roomId, day, slot);
    const list = cells.get(key);
    if (list) list.push(session);
    else cells.set(key, [session]);
  }

  return (
    <div className="grid gap-4 lg:grid-cols-[16rem_1fr]">
      <aside className="rounded border border-gray-200 p-3 dark:border-gray-800">
        <h3 className="mb-2 text-sm font-semibold">
          Unscheduled <span className="text-gray-500">({tray.length})</span>
        </h3>
        <p className="mb-2 text-xs text-gray-500">
          Drag a session onto a room and time — or use the form on its card in List view.
        </p>
        <Tray>
          {tray.length === 0 ? (
            <p className="rounded border border-dashed border-gray-300 p-3 text-xs text-gray-500 dark:border-gray-700">
              Everything is on the agenda.
            </p>
          ) : (
            tray.map((session) => <Card key={session.id} session={session} />)
          )}
        </Tray>
      </aside>

      <div className="overflow-x-auto">
        {rooms.length === 0 ? (
          <p className="rounded border border-dashed border-gray-300 p-6 text-sm text-gray-500 dark:border-gray-700">
            No rooms yet. Add one under{" "}
            <a className="underline" href="/admin/agenda/rooms">
              Rooms
            </a>{" "}
            to build the day board.
          </p>
        ) : (
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr>
                <th className="w-16 border-b border-gray-200 p-1 text-left text-xs font-medium text-gray-500 dark:border-gray-800">
                  Time
                </th>
                {rooms.map((room) => (
                  <th
                    key={room.id}
                    className="border-b border-l border-gray-200 p-1 text-left text-xs font-medium dark:border-gray-800"
                  >
                    {room.name}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {slots.map((time) => (
                <tr key={time}>
                  <th className="border-t border-gray-200 p-1 text-left align-top text-[11px] font-normal text-gray-500 dark:border-gray-800">
                    {time}
                  </th>
                  {rooms.map((room) => {
                    const id = slotId(room.id, day, time);
                    return (
                      <Cell key={id} id={id}>
                        <div className="space-y-1">
                          {(cells.get(id) ?? []).map((session) => (
                            <Card key={session.id} session={session} />
                          ))}
                        </div>
                      </Cell>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {offGrid.length > 0 ? (
          <p
            data-off-grid={offGrid.length}
            className="mt-3 rounded border border-gray-200 p-2 text-xs text-gray-500 dark:border-gray-800"
          >
            {`${offGrid.length} session${offGrid.length === 1 ? "" : "s"} on this day are not on the grid — no room, or a start outside 08:00–20:00: ${offGrid
              .map((s) => s.title)
              .join(", ")}. Use the List or Room view to place them.`}
          </p>
        ) : null}
      </div>
    </div>
  );
}

/** SSR / no-JS rendering. Identical grid, no drag. */
export function AgendaBoard(props: BoardProps) {
  return <BoardShell {...props} Card={PlainCard} Cell={PlainCell} Tray={PlainTray} />;
}

/** Client-only rendering with drag-and-drop. Must live inside `<ClientOnly>`. */
export function DndAgendaBoard(props: BoardProps) {
  // A small activation distance keeps a plain click on a card from starting a
  // drag, which would otherwise swallow the keyboard-reachable controls.
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));

  function onDragEnd(event: DragEndEvent) {
    const sessionId = String(event.active.id);
    const overId = String(event.over?.id ?? "");
    if (!overId) return;

    const form = document.getElementById(DROP_FORM_ID);
    if (!(form instanceof HTMLFormElement)) return;

    const set = (name: string, value: string) => {
      const field = form.elements.namedItem(name);
      if (field instanceof HTMLInputElement) field.value = value;
    };

    if (overId === TRAY_DROPPABLE_ID) {
      set("intent", "unschedule");
      set("sessionId", sessionId);
    } else {
      const slot = parseSlotId(overId);
      if (!slot) return;
      const minutes = Number(event.active.data.current?.durationMinutes) || 30;
      set("intent", "schedule");
      set("sessionId", sessionId);
      set("roomId", slot.roomId);
      set("day", slot.day);
      set("time", slot.time);
      set("durationMinutes", String(minutes));
    }
    form.requestSubmit();
  }

  return (
    <DndContext sensors={sensors} collisionDetection={slotCollision} onDragEnd={onDragEnd}>
      <BoardShell {...props} Card={DraggableCard} Cell={DroppableCell} Tray={DroppableTray} />
    </DndContext>
  );
}
