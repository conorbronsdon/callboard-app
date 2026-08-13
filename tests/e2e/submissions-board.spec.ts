import { expect, test, type Page } from "@playwright/test";

async function openSubmissionsBoard(page: Page) {
  await page.goto("/demo");
  await page
    .getByRole("button", { name: "Enter organizer workspace", exact: true })
    .click();
  await expect(page).toHaveURL(/\/admin$/, { timeout: 30_000 });
  await page
    .getByTestId("admin-nav-group-programme")
    .locator("summary")
    .click();
  await page
    .locator("header nav")
    .getByRole("link", { name: "Submissions", exact: true })
    .click();
  await expect(page).toHaveURL(/\/admin\/submissions(?:\?.*)?$/);
  await page.getByRole("link", { name: "Board", exact: true }).click();
  await expect(page).toHaveURL(/\/admin\/submissions\/board$/);
}

test("a seeded abstract moves across the submissions board through the fallback control", async ({
  page,
}) => {
  await openSubmissionsBoard(page);

  const board = page.getByTestId("submissions-board");
  const accepted = page.getByTestId("submissions-board-column-accepted");
  const pending = page.getByTestId("submissions-board-column-pending");
  const acceptQueue = page.getByTestId("submissions-board-column-accept_queue");
  await expect(board).toBeVisible();
  // 5 accepted comes straight from scripts/seed.mjs's STATUS_PLAN and nothing
  // else in this single-worker suite reaches "accepted" as a side effect (it
  // only moves there through an explicit decision commit). Pending has no
  // fixed count asserted here on purpose: several earlier specs (pitch
  // capture, "Add Abstract", portal-form submission) land new rows there as
  // a side effect of running first in the same shared, disposable D1, so an
  // exact count would be asserting suite ordering, not this board.
  await expect(accepted.locator("article")).toHaveCount(5);

  const title = "Model Quantization: Achieving Efficiency Without Sacrificing Quality";
  const card = pending.locator("article").filter({ hasText: title });
  await expect(card).toHaveCount(1);
  await card.getByLabel(`Status for ${title}`).selectOption("accept_queue");
  await card.getByRole("button", { name: "Move", exact: true }).click();

  await expect(
    acceptQueue.getByRole("link", { name: title, exact: true }),
  ).toBeVisible();
});
