import { expect, test, type Page } from "@playwright/test";

/*
 * The ws9 prefix keeps this journey behind the cold-compile payer in the
 * single-worker suite, matching the contacts spec's ordering contract.
 */
async function openPipeline(page: Page) {
  await page.goto("/demo");
  await page.getByRole("button", { name: "Enter organizer workspace", exact: true }).click();
  await expect(page).toHaveURL(/\/admin$/, { timeout: 30_000 });
  await page.locator("header nav").getByRole("link", { name: "Pipeline", exact: true }).click();
  await expect(page).toHaveURL(/\/admin\/pipeline$/);
}

test("a seeded contact moves across the sourcing board and records the transition", async ({
  page,
}) => {
  await openPipeline(page);

  const board = page.getByTestId("pipeline-board");
  const prospect = page.getByTestId("pipeline-column-prospect");
  const conversation = page.getByTestId("pipeline-column-in_conversation");
  const contacted = page.getByTestId("pipeline-column-contacted");
  await expect(board).toBeVisible();
  await expect(prospect.locator("article")).toHaveCount(1);
  await expect(conversation.locator("article")).toHaveCount(1);

  const contactName = "Marcus Chen";
  const card = prospect.locator("article").filter({ hasText: contactName });
  await expect(card).toHaveCount(1);
  await card.getByLabel(`Stage for ${contactName}`).selectOption("contacted");
  await card.getByRole("button", { name: "Move", exact: true }).click();

  await expect(contacted.getByRole("link", { name: contactName, exact: true })).toBeVisible();
  await contacted.getByRole("link", { name: contactName, exact: true }).click();
  await expect(page).toHaveURL(/\/admin\/contacts\/[^/]+$/);
  await expect(page.getByTestId("pipeline-transitions")).toContainText(
    "Prospect -> Contacted",
  );
});
