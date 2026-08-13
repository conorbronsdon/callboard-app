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
  const card = page.locator("button[data-session-card]").first();
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

  const from = await card.boundingBox();
  const to = await tray.boundingBox();
  await page.mouse.move(from!.x + from!.width / 2, from!.y + from!.height / 2);
  await page.mouse.down();
  await page.mouse.move(from!.x - 20, from!.y + 20, { steps: 5 });
  await page.mouse.move(to!.x + to!.width / 2, to!.y + 40, { steps: 15 });
  await page.mouse.up();

  await page.waitForURL(/cleared=/, { timeout: 15_000 });

  await page.goto("/admin/agenda?view=list");
  await expect(page.locator(`#session-${sessionId}`)).toContainText("Unscheduled");
});

test("the board works with JavaScript disabled — the card form round-trips", async ({
  browser,
}) => {
  // The floor of the layered design (PLAN §4 WS4 / cut ladder №3): with no JS
  // there is no dnd-kit at all, and scheduling must still work.
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
  const row = page.locator("[data-session-row]").first();
  const sessionId = await row.getAttribute("data-session-row");

  // No hydration, so cards are plain divs, never buttons.
  await expect(page.locator("button[data-session-card]")).toHaveCount(0);

  await row.locator("summary").click();
  await row.locator('select[name="day"]').selectOption(DAY);
  await row.locator('input[name="time"]').fill("17:45");
  await row.locator('select[name="durationMinutes"]').selectOption("60");
  await row.getByRole("button", { name: "Save" }).click();

  await page.waitForURL(/moved=/, { timeout: 15_000 });
  await page.goto("/admin/agenda?view=list");
  await expect(page.locator(`#session-${sessionId}`)).toContainText("5:45 PM – 6:45 PM");

  await context.close();
});
