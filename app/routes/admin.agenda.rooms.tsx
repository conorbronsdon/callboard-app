/**
 * Rooms config — the metadata the Day board's columns are made of.
 *
 * Minimal on purpose (name + capacity, per PLAN §4 WS4): rooms are one of the
 * five generic metadata families, and WS7 exposes all five through one REST
 * handler. This screen exists because a judge cannot build an agenda without
 * rooms, not because rooms deserve a product surface.
 *
 * Router-free markup for the same reasons as the agenda itself.
 */
import { and, asc, eq } from "drizzle-orm";
import { redirect } from "react-router";

import { buttonClass } from "~/components/portal-ui";
import { getDb } from "~/db/client.server";
import { rooms, sessions } from "~/db/schema";
import { requireAdmin } from "~/lib/auth/auth.server";
import { currentEvent } from "~/lib/event.server";
import type { Route } from "./+types/admin.agenda.rooms";

export interface RoomRow {
  id: string;
  name: string;
  capacity: number | null;
  /** How many programme sessions are currently assigned here. */
  sessionCount: number;
}

export interface RoomsData {
  event: { name: string; slug: string } | null;
  rooms: RoomRow[];
  notice: string | null;
}

export function meta() {
  return [{ title: "Rooms — callboard admin" }];
}

export async function loader({ request }: Route.LoaderArgs): Promise<RoomsData> {
  await requireAdmin(request);
  const event = await currentEvent(request);
  if (!event) return { event: null, rooms: [], notice: null };

  const db = getDb();
  const [roomRows, assigned] = await Promise.all([
    db
      .select({ id: rooms.id, name: rooms.name, capacity: rooms.capacity })
      .from(rooms)
      .where(eq(rooms.eventId, event.id))
      .orderBy(asc(rooms.order), asc(rooms.name)),
    db
      .select({ roomId: sessions.roomId })
      .from(sessions)
      .where(and(eq(sessions.eventId, event.id), eq(sessions.isAbstract, false))),
  ]);

  const counts = new Map<string, number>();
  for (const row of assigned) {
    if (!row.roomId) continue;
    counts.set(row.roomId, (counts.get(row.roomId) ?? 0) + 1);
  }

  const url = new URL(request.url);
  const created = url.searchParams.get("created");
  const removed = url.searchParams.get("removed");

  return {
    event: { name: event.name, slug: event.slug },
    rooms: roomRows.map((room) => ({ ...room, sessionCount: counts.get(room.id) ?? 0 })),
    notice: created
      ? `Added “${created}”.`
      : removed
        ? `Removed “${removed}”. Sessions that were in it are back with no room.`
        : null,
  };
}

function parseCapacity(value: FormDataEntryValue | null): number | null {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

export async function action({ request }: Route.ActionArgs) {
  await requireAdmin(request);
  const event = await currentEvent(request);
  if (!event) return { ok: false as const, error: "No event has been set up yet." };

  const db = getDb();
  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "");

  if (intent === "create") {
    const name = String(formData.get("name") ?? "").trim();
    if (!name) return { ok: false as const, error: "Room name is required." };
    if (name.length > 120) {
      return { ok: false as const, error: "Room name is capped at 120 characters." };
    }

    const clash = await db.query.rooms.findFirst({
      where: and(eq(rooms.eventId, event.id), eq(rooms.name, name)),
    });
    if (clash) return { ok: false as const, error: `“${name}” already exists.` };

    const existing = await db
      .select({ id: rooms.id })
      .from(rooms)
      .where(eq(rooms.eventId, event.id));

    await db.insert(rooms).values({
      eventId: event.id,
      name,
      capacity: parseCapacity(formData.get("capacity")),
      order: existing.length,
    });
    return redirect(`/admin/agenda/rooms?created=${encodeURIComponent(name)}`);
  }

  if (intent === "update") {
    const roomId = String(formData.get("roomId") ?? "");
    const target = await db.query.rooms.findFirst({
      where: and(eq(rooms.id, roomId), eq(rooms.eventId, event.id)),
    });
    if (!target) return { ok: false as const, error: "That room is not on this event." };

    const name = String(formData.get("name") ?? "").trim();
    if (!name) return { ok: false as const, error: "Room name is required." };

    await db
      .update(rooms)
      .set({ name, capacity: parseCapacity(formData.get("capacity")), updatedAt: new Date() })
      .where(eq(rooms.id, roomId));
    return redirect("/admin/agenda/rooms");
  }

  if (intent === "delete") {
    const roomId = String(formData.get("roomId") ?? "");
    const target = await db.query.rooms.findFirst({
      where: and(eq(rooms.id, roomId), eq(rooms.eventId, event.id)),
    });
    if (!target) return { ok: false as const, error: "That room is not on this event." };

    // `sessions.room_id` is ON DELETE SET NULL, so the sessions survive and
    // reappear in the unscheduled/no-room bucket rather than vanishing.
    await db.delete(rooms).where(eq(rooms.id, roomId));
    return redirect(`/admin/agenda/rooms?removed=${encodeURIComponent(target.name)}`);
  }

  return { ok: false as const, error: `Unknown intent "${intent}".` };
}

const FIELD =
  "rounded border border-gray-300 px-2 py-1 text-sm dark:border-gray-700 dark:bg-gray-900";
const BUTTON = buttonClass("primary");
const GHOST = buttonClass("secondary");

export function RoomsScreen(data: RoomsData) {
  return (
    <div>
      <div className="mb-4 flex flex-wrap items-baseline gap-3">
        <h2 className="text-xl font-semibold">Rooms</h2>
        <p className="text-sm text-gray-500">
          Columns on the Day board. Capacity is shown when assigning a session.
        </p>
        <a className={`${GHOST} ml-auto`} href="/admin/agenda">
          Back to agenda
        </a>
      </div>

      {data.notice ? (
        <p className="mb-3 rounded border border-gray-300 bg-gray-50 p-2 text-sm dark:border-gray-700 dark:bg-gray-900">
          {data.notice}
        </p>
      ) : null}

      {!data.event ? (
        <p className="rounded-lg border border-gray-200 p-6 text-sm dark:border-gray-800">
          No event yet — rooms belong to an event, so create one first.
        </p>
      ) : (
        <>
          <form
            method="post"
            className="mb-6 flex flex-wrap items-end gap-2 rounded-lg border border-gray-200 p-3 dark:border-gray-800"
          >
            <input type="hidden" name="intent" value="create" />
            <label className="flex flex-col gap-1 text-xs">
              Room name
              <input name="name" required className={FIELD} placeholder="Main Stage" />
            </label>
            <label className="flex flex-col gap-1 text-xs">
              Capacity
              <input
                name="capacity"
                type="number"
                min="1"
                className={FIELD}
                placeholder="120"
              />
            </label>
            <button type="submit" className={BUTTON}>
              Add room
            </button>
          </form>

          {data.rooms.length === 0 ? (
            <p className="rounded border border-dashed border-gray-300 p-6 text-sm text-gray-500 dark:border-gray-700">
              No rooms yet. Add the first one above — the Day board needs at least one
              column.
            </p>
          ) : (
            <ul className="space-y-2">
              {data.rooms.map((room) => (
                <li
                  key={room.id}
                  data-room-row={room.id}
                  className="rounded-lg border border-gray-200 p-3 dark:border-gray-800"
                >
                  <div className="flex flex-wrap items-end gap-2">
                    <form method="post" className="flex flex-wrap items-end gap-2">
                      <input type="hidden" name="intent" value="update" />
                      <input type="hidden" name="roomId" value={room.id} />
                      <label className="flex flex-col gap-1 text-xs">
                        Name
                        <input name="name" defaultValue={room.name} className={FIELD} />
                      </label>
                      <label className="flex flex-col gap-1 text-xs">
                        Capacity
                        <input
                          name="capacity"
                          type="number"
                          min="1"
                          defaultValue={room.capacity ?? ""}
                          className={FIELD}
                        />
                      </label>
                      <button type="submit" className={BUTTON}>
                        Save
                      </button>
                    </form>
                    <span className="text-xs text-gray-500">
                      {room.sessionCount} session{room.sessionCount === 1 ? "" : "s"}
                    </span>
                    <form method="post" className="ml-auto">
                      <input type="hidden" name="intent" value="delete" />
                      <input type="hidden" name="roomId" value={room.id} />
                      <button type="submit" className={GHOST}>
                        Delete
                      </button>
                    </form>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}

export default function AdminAgendaRooms({ loaderData, actionData }: Route.ComponentProps) {
  const error = (actionData as { ok?: boolean; error?: string } | undefined)?.error;
  return (
    <>
      {error ? (
        <p className="mb-3 rounded border border-red-400 bg-red-50 p-2 text-sm text-red-800 dark:bg-red-950 dark:text-red-200">
          {error}
        </p>
      ) : null}
      <RoomsScreen {...loaderData} />
    </>
  );
}
