import { expect, test } from "@playwright/test";

/**
 * WS4: drag-and-drop on the Day board POSTs the SAME mutation as the JS-off form.
 *
 * This is the required noun of feature 5 ("drag-and-drop schedule/agenda
 * builder"), so it gets a test that can actually fail rather than a screenshot.
 * The board runs @dnd-kit inside `<ClientOnly>`; a drop fills in the
 * server-rendered `#agenda-drop-form` and submits it, which is why the assertion
 * after the drop is a real navigation + persisted position, not a DOM tweak.
 *
 * Desktop viewport on purpose — the repo default is a 375px phone (the CFP form
 * is mobile-first), but an organiser builds an agenda on a laptop.
 */
test.use({ viewport: { width: 1440, height: 1000 } });

const DAY = "2026-10-07";

type Page = import("@playwright/test").Page;

async function signInAsAdmin(page: Page) {
  await page.goto("/demo");
  await page.getByRole("button", { name: "Enter organizer workspace", exact: true }).click();
  await page.waitForURL(/\/admin/);
}

function attrValues(html: string, attr: string): string[] {
  return [...html.matchAll(new RegExp(`data-${attr}="([^"]+)"`, "g"))].map((m) => m[1]);
}

/**
 * Fail loudly when a drag would start or end off-screen.
 *
 * `page.mouse` works in VIEWPORT coordinates, but `boundingBox()` reports where
 * an element sits in the page without scrolling to it, and `toBeVisible()` is
 * satisfied by an element that is merely rendered — below the fold included.
 * Press at a y beyond the viewport and the mouse lands on nothing: dnd-kit
 * never arms, no form is submitted, and the only symptom is the navigation wait
 * timing out fifteen seconds later with nothing to read.
 *
 * How far down the board's first card sits is decided by the DATA, not the
 * code: the informed-holds banner (#147) appears whenever a scheduled but
 * unpublished session still owes its speaker a letter, a full tray is taller
 * than an empty one, and a day whose only sessions are late in the afternoon
 * puts its first card fourteen slot rows down. That combination is why the tray
 * test passed on a fresh seed and failed once twenty other specs had moved the
 * programme around — the seam was always here, the seeded layout was hiding it.
 */
function assertOnScreen(page: Page, label: string, point: { x: number; y: number }) {
  const viewport = page.viewportSize()!;
  expect(point.x, `${label} point is within the viewport horizontally`).toBeGreaterThanOrEqual(0);
  expect(point.x, `${label} point is within the viewport horizontally`).toBeLessThanOrEqual(
    viewport.width,
  );
  expect(point.y, `${label} point is within the viewport vertically`).toBeGreaterThanOrEqual(0);
  expect(point.y, `${label} point is within the viewport vertically`).toBeLessThanOrEqual(
    viewport.height,
  );
}

interface BoardCell {
  roomId: string;
  time: string;
  cardIds: string[];
}

/**
 * Every room×time cell of the day board, and which sessions are sitting in it.
 *
 * Read from the board rather than hard-coded, because "is 17:45 free?" is a
 * property of the SEED, not of the product. This spec used to name a time and a
 * duration outright; the seed grew denser, that slot stopped being empty, and a
 * test about JS-off form round-trips started failing for reasons that had
 * nothing to do with JavaScript. Asking the board keeps the intent ("a cell
 * nobody is in" / "a cell somebody is in") stable as the programme changes.
 *
 * Each cell's markup runs from its own `data-slot` to its closing tag and holds
 * no nested cell, so a non-greedy match per `<td>` is exact.
 */
async function dayBoardCells(page: Page, day: string): Promise<BoardCell[]> {
  const html = await (await page.request.get(`/admin/agenda?view=day&day=${day}`)).text();
  const cells: BoardCell[] = [];
  for (const match of html.matchAll(/<td[^>]*data-slot="([^"]+)"[^>]*>([\s\S]*?)<\/td>/g)) {
    // `slot|<roomId>|<day>|<time>` — the literal prefix is part of the id, which
    // is also why the drop-target locators below match on the `|DAY|HH:MM` tail.
    const [, roomId, , time] = match[1].split("|");
    // The tray droppable is `data-slot="tray"` — no slot|room|day|time shape.
    if (!time) continue;
    cells.push({
      roomId,
      time,
      cardIds: [...match[2].matchAll(/data-session-card="([^"]+)"/g)].map((card) => card[1]),
    });
  }
  expect(cells.length, "the day board rendered room×time cells").toBeGreaterThan(0);
  return cells;
}

/** "17:45" → "5:45 PM", the label the list view prints. */
function timeLabel(time: string): string {
  const [hours, minutes] = time.split(":").map(Number);
  const suffix = hours >= 12 ? "PM" : "AM";
  const hour12 = hours % 12 === 0 ? 12 : hours % 12;
  return `${hour12}:${String(minutes).padStart(2, "0")} ${suffix}`;
}

/**
 * Put the programme in a KNOWN state before each test, through the product's own
 * action rather than a SQL fixture. Tests then do not depend on each other's
 * leftovers, nor on whatever the last `npm run seed` or acceptance-harness run
 * left in the local D1.
 */
async function resetProgramme(page: Page): Promise<string[]> {
  const list = await (await page.request.get("/admin/agenda?view=list")).text();
  const sessionIds = attrValues(list, "session-row");
  const roomsHtml = await (await page.request.get("/admin/agenda/rooms")).text();
  const roomIds = attrValues(roomsHtml, "room-row");
  expect(sessionIds.length, "seeded programme sessions").toBeGreaterThanOrEqual(2);
  expect(roomIds.length, "seeded rooms").toBeGreaterThanOrEqual(2);

  for (const [index, sessionId] of sessionIds.slice(0, 2).entries()) {
    await page.request.post("/admin/agenda", {
      form: {
        intent: "schedule",
        sessionId,
        roomId: roomIds[index],
        day: DAY,
        time: index === 0 ? "15:00" : "16:00",
        durationMinutes: "30",
        view: "day",
        returnDay: DAY,
      },
      maxRedirects: 0,
    });
  }
  return sessionIds;
}

test("dragging a session into a room×time slot persists it via the schedule action", async ({
  page,
}) => {
  await signInAsAdmin(page);
  await resetProgramme(page);
  await page.goto(`/admin/agenda?view=day&day=${DAY}`);

  // The drop target form is SERVER-rendered — it must exist before hydration.
  await expect(page.locator("#agenda-drop-form")).toHaveCount(1);

  // Hydration turns the static cards into draggable buttons. Waiting for the
  // button form is the honest "dnd is live now" signal.
  //
  // Scoped to `td[data-slot]` — the tray renders cards too, and it comes FIRST
  // in the DOM, so the unscoped selector returned an UNSCHEDULED card whenever
  // the tray was non-empty. The origin-slot lookup below then waited for a card
  // that is by definition in no cell at all. Whether that happened was decided
  // by whatever earlier specs left in the tray, which is not a thing this test
  // should be measuring.
  const card = page.locator("td[data-slot] button[data-session-card]").first();
  await expect(card).toBeVisible({ timeout: 15_000 });

  const sessionId = await card.getAttribute("data-session-card");
  expect(sessionId).toBeTruthy();

  // Where it is now…
  const originSlot = await page
    .locator(`td[data-slot]:has(button[data-session-card="${sessionId}"])`)
    .getAttribute("data-slot");
  expect(originSlot).toBeTruthy();

  // …and an empty cell in a different room, early in the day.
  const target = page.locator(`td[data-slot$="|${DAY}|09:00"]`).last();
  const targetSlot = await target.getAttribute("data-slot");
  expect(targetSlot).toBeTruthy();
  expect(targetSlot).not.toBe(originSlot);
  await expect(target.locator("[data-session-card]")).toHaveCount(0);

  // Drag with intermediate moves: @dnd-kit's PointerSensor needs movement past
  // its activation distance before it starts tracking.
  const from = await card.boundingBox();
  const to = await target.boundingBox();
  expect(from && to).toBeTruthy();

  await page.mouse.move(from!.x + from!.width / 2, from!.y + from!.height / 2);
  await page.mouse.down();
  await page.mouse.move(from!.x + from!.width / 2 + 20, from!.y + from!.height / 2 + 20, {
    steps: 5,
  });
  await page.mouse.move(to!.x + to!.width / 2, to!.y + to!.height / 2, { steps: 15 });

  // Re-measure before releasing. Grabbing a card low on the board puts the
  // cursor inside dnd-kit's auto-scroll zone, so the page scrolls a few pixels
  // while the drag is in flight (9 px vertically and 6 px horizontally in a
  // 1440×1000 run) and `to` — read BEFORE the drag — is stale by that much
  // against a 24.7 px slot row. Releasing on the stale coordinates would be a
  // test measuring scroll timing rather than the drop.
  const settled = await target.boundingBox();
  await page.mouse.move(settled!.x + settled!.width / 2, settled!.y + settled!.height / 2, {
    steps: 5,
  });
  await page.mouse.up();

  // The drop submits the real form, so the browser NAVIGATES. If drag were a
  // client-only illusion this wait would time out.
  await page.waitForURL(/moved=/, { timeout: 15_000 });

  // The move persisted: a fresh load puts the card in the target cell.
  await page.goto(`/admin/agenda?view=day&day=${DAY}`);
  await expect(
    page.locator(`td[data-slot="${targetSlot}"] [data-session-card="${sessionId}"]`),
  ).toHaveCount(1);
  await expect(
    page.locator(`td[data-slot="${originSlot}"] [data-session-card="${sessionId}"]`),
  ).toHaveCount(0);

  // …and the List view — a different query entirely — agrees.
  await page.goto("/admin/agenda?view=list");
  await expect(page.locator(`#session-${sessionId}`)).toContainText("9:00 AM");
});

test("dropping a card on the unscheduled tray clears its time", async ({ page }) => {
  await signInAsAdmin(page);
  await resetProgramme(page);
  await page.goto(`/admin/agenda?view=day&day=${DAY}`);

  const card = page.locator("td[data-slot] button[data-session-card]").first();
  await expect(card).toBeVisible({ timeout: 15_000 });
  const sessionId = await card.getAttribute("data-session-card");

  const tray = page.locator('[data-slot="tray"]');
  await expect(tray).toBeVisible();

  // Bring the card on-screen before measuring — see assertOnScreen. Scrolling
  // to the card moves the tray up by the same amount and the two are close
  // enough together to share a screen; the guards say so rather than trust it.
  await card.scrollIntoViewIfNeeded();
  const from = await card.boundingBox();
  const to = await tray.boundingBox();
  const grab = { x: from!.x + from!.width / 2, y: from!.y + from!.height / 2 };
  const drop = { x: to!.x + to!.width / 2, y: to!.y + 40 };
  assertOnScreen(page, "grab", grab);
  assertOnScreen(page, "drop", drop);

  await page.mouse.move(grab.x, grab.y);
  await page.mouse.down();
  await page.mouse.move(grab.x - 20, grab.y + 20, { steps: 5 });
  await page.mouse.move(drop.x, drop.y, { steps: 15 });

  // Re-measure before releasing, for the same reason the test above does: the
  // drag can put the cursor in dnd-kit's auto-scroll zone, which moves the tray
  // out from under coordinates read before the drag started.
  const settled = await tray.boundingBox();
  await page.mouse.move(settled!.x + settled!.width / 2, settled!.y + 40, { steps: 5 });
  await page.mouse.up();

  await page.waitForURL(/cleared=/, { timeout: 15_000 });

  await page.goto("/admin/agenda?view=list");
  await expect(page.locator(`#session-${sessionId}`)).toContainText("Unscheduled");
});

test("the board works with JavaScript disabled — the card form round-trips, and the blocking gate covers it", async ({
  browser,
}) => {
  // The floor of the layered design (PLAN §4 WS4 / cut ladder №3): with no JS
  // there is no dnd-kit at all, and scheduling must still work.
  //
  // It is also where DECISIONS #70's central claim gets tested. The gate that
  // refuses a physically impossible placement lives in the ACTION, which the
  // drag and this <details> form both POST — "prediction covers both paths by
  // construction". Construction is an argument; this is the measurement. If the
  // gate were ever wired into the drag handler instead, every drag test would
  // stay green and only this one would notice.
  const context = await browser.newContext({
    javaScriptEnabled: false,
    viewport: { width: 1440, height: 1000 },
  });
  const page = await context.newPage();

  await page.goto("/demo");
  await page.getByRole("button", { name: "Enter organizer workspace", exact: true }).click();
  await page.waitForURL(/\/admin/);
  await resetProgramme(page);

  await page.goto("/admin/agenda?view=list");
  const sessionId = await page.locator("[data-session-row]").first().getAttribute("data-session-row");
  expect(sessionId).toBeTruthy();

  /*
   * PINNED to the id, not `.first()`.
   *
   * A locator is lazy — it re-resolves on every use — and the list groups
   * Unscheduled rows before Scheduled ones. So the moment step 1 schedules this
   * session, it leaves the top group and `.first()` starts resolving to a
   * DIFFERENT session. An earlier draft of this test re-used a `.first()` row
   * and spent steps 2 and 3 driving some other session's form while asserting
   * against this one's id; it went red for the right reason by luck and would
   * have gone green for the wrong one just as easily.
   */
  const row = page.locator(`[data-session-row="${sessionId}"]`);

  // No hydration, so cards are plain divs, never buttons.
  await expect(page.locator("button[data-session-card]")).toHaveCount(0);

  const cells = await dayBoardCells(page, DAY);
  const empty = cells.find((cell) => cell.cardIds.length === 0);
  // Somebody ELSE's cell: a session cannot double-book itself, and predict.ts
  // replaces rather than appends precisely so a no-op re-drop is not a clash.
  const occupied = cells.find(
    (cell) => cell.cardIds.length > 0 && !cell.cardIds.includes(sessionId!),
  );
  expect(empty, "an empty room×time cell on the day board").toBeTruthy();
  expect(occupied, "a cell already holding another session").toBeTruthy();

  /* ── 1. a clean move still round-trips with no JavaScript at all ───────── */
  const save = async (roomId: string, time: string) => {
    await row.locator("summary").click();
    await row.locator('select[name="roomId"]').selectOption(roomId);
    await row.locator('select[name="day"]').selectOption(DAY);
    await row.locator('input[name="time"]').fill(time);
    await row.locator('select[name="durationMinutes"]').selectOption("30");
    await row.getByRole("button", { name: "Save" }).click();
  };

  await save(empty!.roomId, empty!.time);
  await page.waitForURL(/moved=/, { timeout: 15_000 });
  await page.goto("/admin/agenda?view=list");
  await expect(page.locator(`#session-${sessionId}`)).toContainText(timeLabel(empty!.time));

  /* ── 2. the same form, aimed at an occupied cell, is REFUSED by name ───── */
  await save(occupied!.roomId, occupied!.time);

  // No redirect: the action returns the refusal and the board re-renders with
  // it, so the URL never gains `moved=`.
  await expect(page.getByText(/^Blocked: /)).toBeVisible();
  await expect(page.getByText(/Room double-booked · /)).toBeVisible();
  expect(page.url(), "a refused move does not navigate to a moved= redirect").not.toMatch(
    /moved=/,
  );

  // must-still-fire: the refusal is real, not cosmetic — the session is still
  // where step 1 put it.
  await page.goto("/admin/agenda?view=list");
  await expect(page.locator(`#session-${sessionId}`)).toContainText(timeLabel(empty!.time));

  /* ── 3. "Move anyway" carries the force key through the same JS-off form ─ */
  await save(occupied!.roomId, occupied!.time);
  const moveAnywayForm = page
    .getByRole("button", { name: "Move anyway" })
    .locator("xpath=..");
  await moveAnywayForm.getByLabel("Why?").fill("Venue approved this room overlap.");
  await moveAnywayForm.getByRole("button", { name: "Move anyway" }).click();

  await page.waitForURL(/moved=/, { timeout: 15_000 });
  // `force` and `override` are separate keys on purpose (DECISIONS #70), and a
  // forced move says so in its own banner rather than borrowing the advisory one.
  expect(page.url()).toContain("warn=forced");
  await page.goto("/admin/agenda?view=list");
  await expect(page.locator(`#session-${sessionId}`)).toContainText(timeLabel(occupied!.time));

  await context.close();
});
