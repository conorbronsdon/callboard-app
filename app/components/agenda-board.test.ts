/**
 * The Day board's drop targeting, at the geometry the board actually renders.
 *
 * Every number below was MEASURED in a real 1440×1000 Chromium run of
 * `tests/e2e/ws4-agenda-dnd.spec.ts` (Playwright `boundingBox()` at the moment
 * of the drop), not invented: a slot row is 24.703 px of table, and a card
 * carrying a wrapped title + time + track + speakers + a Draft badge is 82.5 px.
 * A dragged card is therefore ~3.3 rows tall and covers three cells COMPLETELY,
 * which is what makes dnd-kit's default rect-overlap scoring ambiguous here.
 */
import {
  rectIntersection,
  type Active,
  type ClientRect,
  type CollisionDetection,
  type DroppableContainer,
  type UniqueIdentifier,
} from "@dnd-kit/core";
import { describe, expect, it } from "vitest";

import { slotCollision } from "./agenda-board";

const ROW_HEIGHT = 24.703;
const CARD_HEIGHT = 82.5;
const CARD_WIDTH = 240.03;
/** Workshop Room 2's column — the one the drag spec targets. */
const COLUMN_LEFT = 992.61;
const COLUMN_WIDTH = 217.39;
const COLUMN_CENTRE = COLUMN_LEFT + COLUMN_WIDTH / 2;
/** Top of the 08:00 row once the board settled. */
const GRID_TOP = 402.5;

function rect(top: number, left: number, width: number, height: number): ClientRect {
  return { top, left, width, height, right: left + width, bottom: top + height };
}

const SLOT_TIMES = ["08:00", "08:30", "09:00", "09:30", "10:00"];

/** `slot|<room>|<day>|<time>` for Workshop Room 2. */
function slotKey(time: string): string {
  return `slot|000000rm-0000-4000-8000-000000000003|2026-10-07|${time}`;
}

const slotRects = new Map<UniqueIdentifier, ClientRect>(
  SLOT_TIMES.map((time, index) => [
    slotKey(time),
    rect(GRID_TOP + index * ROW_HEIGHT, COLUMN_LEFT, COLUMN_WIDTH, ROW_HEIGHT),
  ]),
);
// The tray sits in the left sidebar and must never win a drop aimed at the grid.
const droppableRects = new Map<UniqueIdentifier, ClientRect>([
  ...slotRects,
  ["tray", rect(300, 40, 240, 500)],
]);
// Registration order matters: it is what breaks a tie inside `rectIntersection`.
const droppableContainers = [...droppableRects.keys()].map(
  (id) => ({ id, rect: { current: droppableRects.get(id)! } }) as unknown as DroppableContainer,
);

const nineAm = slotRects.get(slotKey("09:00"))!;
const nineAmCentre = nineAm.top + nineAm.height / 2;
const gridBottom = GRID_TOP + SLOT_TIMES.length * ROW_HEIGHT;

/** The dragged card, centred on the cursor — where dnd-kit puts it mid-drag. */
function collisionArgs(
  pointer: { x: number; y: number } | null,
  centre = pointer ?? { x: COLUMN_CENTRE, y: nineAmCentre },
): Parameters<CollisionDetection>[0] {
  return {
    active: { id: "000000sp-0000-4000-8000-000000000001" } as unknown as Active,
    collisionRect: rect(
      centre.y - CARD_HEIGHT / 2,
      centre.x - CARD_WIDTH / 2,
      CARD_WIDTH,
      CARD_HEIGHT,
    ),
    droppableRects,
    droppableContainers,
    pointerCoordinates: pointer,
  };
}

describe("slotCollision", () => {
  it("drops into the cell under the cursor, not the one with the biggest overlap", () => {
    const collisions = slotCollision(collisionArgs({ x: COLUMN_CENTRE, y: nineAmCentre }));
    expect(collisions[0]?.id).toBe(slotKey("09:00"));
  });

  it("holds anywhere inside the cell, not only at its exact centre", () => {
    for (const y of [nineAm.top + 1, nineAmCentre, nineAm.bottom - 1]) {
      expect(slotCollision(collisionArgs({ x: COLUMN_CENTRE, y }))[0]?.id).toBe(
        slotKey("09:00"),
      );
    }
  });

  /**
   * MUST-NOT-FIRE control, and the shipped bug pinned. With the cursor in the
   * SAME place, dnd-kit's default scoring hands the drop to 08:30: three cells
   * are covered completely, their ratios tie to four decimals, and the tie goes
   * to whichever was registered first. Without this the assertions above would
   * pass under either algorithm and prove nothing.
   */
  it("is a real change: bare rectIntersection picks the wrong row on this geometry", () => {
    const byOverlap = rectIntersection(collisionArgs({ x: COLUMN_CENTRE, y: nineAmCentre }));
    expect(byOverlap[0]?.id).toBe(slotKey("08:30"));
    expect(byOverlap[0]?.data?.value).toBe(byOverlap[1]?.data?.value);
  });

  it("falls back to overlap when there is no cursor at all (keyboard drag)", () => {
    const collisions = slotCollision(collisionArgs(null));
    expect(collisions[0]?.id).toBe(slotKey("08:30"));
  });

  it("falls back to overlap when the cursor is past the end of the grid", () => {
    const belowGrid = { x: COLUMN_CENTRE, y: gridBottom + 5 };
    expect(slotCollision(collisionArgs(belowGrid))[0]?.id).toBe(slotKey("10:00"));
  });

  it("never hands a grid drop to the tray", () => {
    const ids = slotCollision(collisionArgs({ x: COLUMN_CENTRE, y: nineAmCentre })).map(
      (collision) => collision.id,
    );
    expect(ids).not.toContain("tray");
  });
});
