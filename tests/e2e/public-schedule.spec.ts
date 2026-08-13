import { expect, test } from "@playwright/test";

const SCHEDULE = "/e/frontier-ai-summit-2026/schedule";

test("public schedule search, facets, days, details and personal itinerary", async ({
  page,
}) => {
  await page.goto(SCHEDULE);
  const cards = page.locator("[data-public-session]");
  const search = page.getByLabel("Search sessions and speakers");
  const initialCount = await cards.count();
  expect(initialCount).toBeGreaterThan(2);
  await expect(page.locator("[data-star-session]")).toHaveCount(initialCount);

  await search.fill("100B");
  await expect(cards).toHaveCount(1);
  await expect(page.locator("[data-result-count]")).toHaveAttribute("data-result-count", "1");
  await search.fill("");
  await expect(cards).toHaveCount(initialCount);

  await search.fill("Rodriguez");
  await expect(cards).toHaveCount(1);
  await expect(
    cards.first().locator("[data-speaker-name]", { hasText: "Rodriguez" }),
  ).toHaveCount(1);
  await search.fill("");

  await page.getByLabel("Track").selectOption("Infrastructure");
  await expect(cards).not.toHaveCount(0);
  const trackCards = await cards.count();
  for (let index = 0; index < trackCards; index += 1) {
    await expect(cards.nth(index).locator('[data-session-track="Infrastructure"]')).toBeVisible();
  }
  await page.getByLabel("Track").selectOption("");

  const allIds = await cards.evaluateAll((nodes) =>
    nodes.map((node) => node.getAttribute("data-public-session")),
  );
  const dayTabs = page.locator("[data-day-tab]").filter({ hasNotText: "All days" });
  await dayTabs.last().click();
  const selectedLabel = await dayTabs.last().textContent();
  await expect(page.locator("[data-selected-day]")).toHaveText(selectedLabel ?? "");
  const dayIds = await cards.evaluateAll((nodes) =>
    nodes.map((node) => node.getAttribute("data-public-session")),
  );
  expect(dayIds).not.toEqual(allIds);

  const surname = await cards.first().locator("[data-speaker-name]").textContent();
  await search.fill(surname?.split(" ").at(-1) ?? "");
  const queryBeforeDetail = await search.inputValue();
  const dayBeforeDetail = await page.locator("[data-selected-day]").textContent();
  await cards.first().getByRole("link", { name: /Session details/ }).click();
  const detail = page.locator("[data-public-session-detail]");
  await expect(detail.locator("[data-session-room]")).toBeVisible();
  await expect(detail.locator("[data-session-format]")).toBeVisible();
  await expect(detail.locator("[data-session-track]")).toBeVisible();
  await expect(detail).toContainText(/\d{1,2}:\d{2} [AP]M – \d{1,2}:\d{2} [AP]M/);
  await detail.getByRole("link", { name: "← Back to schedule" }).click();
  await expect(search).toHaveValue(queryBeforeDetail);
  await expect(page.locator("[data-selected-day]")).toHaveText(dayBeforeDetail ?? "");

  // Reset navigates to the canonical URL, so wait for the full programme to be
  // back before sampling: slicing mid-navigation silently samples one card and
  // the failure then surfaces two assertions later, pointing at the wrong bug.
  await page.getByRole("link", { name: "Reset filters" }).first().click();
  await expect(cards).toHaveCount(initialCount);
  const firstTwo = await cards.evaluateAll((nodes) =>
    nodes.slice(0, 2).map((node) => node.getAttribute("data-public-session") ?? ""),
  );
  expect(firstTwo).toHaveLength(2);
  for (const id of firstTwo) await page.locator(`[data-star-session="${id}"]`).click();
  await page.locator("[data-my-schedule-toggle]").click();
  await expect(cards).toHaveCount(2);
  expect(await cards.evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-public-session")))).toEqual(firstTwo);

  await page.reload();
  await expect(page.locator("[data-my-schedule-toggle]")).toContainText("(2)");
  await page.locator("[data-my-schedule-toggle]").click();
  await expect(cards).toHaveCount(2);
  const exportLink = page.locator("[data-my-schedule-export]");
  await expect(exportLink).toBeVisible();
  const href = (await exportLink.getAttribute("href")) ?? "";
  for (const id of firstTwo) expect(href).toContain(id);
});
