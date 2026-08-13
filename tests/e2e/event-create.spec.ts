/**
 * An organizer creates an event through the visible admin affordance and then
 * stays inside that empty event across ordinary navigation. The load-bearing
 * assertion is the click on `admin-new-event`: visiting the URL directly would
 * let this pass even if no organizer could discover event creation. Switching
 * back at the end proves that the empty screens are isolation, not lost seed
 * data.
 */
import { expect, test, type Page } from "@playwright/test";

const PRIMARY_SLUG = "frontier-ai-summit-2026";
const PRIMARY_NAME = "Frontier AI Summit 2026";
const NEW_SLUG = "agent-systems-lab-2027";
const NEW_NAME = "Agent Systems Lab 2027";
const PRIMARY_SESSION = "Building LLM Infrastructure That Scales";

function adminNav(page: Page) {
  return page.locator("header nav");
}

function switcher(page: Page) {
  return page.getByTestId("admin-event-switcher");
}

test("an organizer creates and administers a new empty event", async ({ page }) => {
  await page.goto("/demo");
  await page.getByRole("button", { name: "Enter organizer workspace", exact: true }).click();
  /*
   * Longer than the 10s `expect` default, and only here. `event-create` now
   * sorts first in `tests/e2e/`, so this is the request that pays for the Vite
   * dev server's cold start — the first POST compiles the route graph, and a
   * loaded machine can push it past 10s. Observed once as a red run whose
   * re-run was green. Every later assertion keeps the default timeout: a slow
   * FIRST byte is an environment fact, while a slow anything-else is a bug.
   */
  await expect(page).toHaveURL(/\/admin$/, { timeout: 30_000 });

  await page.getByTestId("admin-new-event").click();
  await expect(page).toHaveURL(/\/admin\/events\/new$/);
  await expect(page.getByRole("heading", { name: "New event" })).toBeVisible();

  const form = page.getByTestId("admin-new-event-form");
  await form.getByLabel("Event name").fill(NEW_NAME);
  await form.getByLabel("Slug").fill(NEW_SLUG);
  await form.getByLabel("Location").fill("Berkeley, CA");
  await form.getByLabel("Starts").fill("2027-05-14");
  await form.getByLabel("Ends").fill("2027-05-16");
  await form.getByLabel("Timezone").fill("America/Los_Angeles");
  await form.getByRole("button", { name: "Create event", exact: true }).click();

  await expect(page).toHaveURL(/\/admin$/);
  await expect(page.getByRole("banner")).toContainText(NEW_NAME);
  await expect(switcher(page)).toHaveAttribute("data-current-event", NEW_SLUG);

  // Dashboard zero state: explicit zero guidance, with no default-event people.
  await expect(page.getByText("Nothing is accepting submissions")).toBeVisible();
  await expect(page.getByText("Nothing new in the last 7 days")).toBeVisible();
  await expect(page.getByText("Sam Speaker")).toHaveCount(0);

  await adminNav(page).getByRole("link", { name: "Submissions", exact: true }).click();
  await expect(page).toHaveURL(/\/admin\/submissions$/);
  await expect(page.getByText("No abstracts in Pending yet.")).toBeVisible();
  await expect(page.getByText("Sam Speaker")).toHaveCount(0);
  await expect(page.getByText(PRIMARY_SESSION, { exact: false })).toHaveCount(0);
  await expect(switcher(page)).toHaveAttribute("data-current-event", NEW_SLUG);

  await adminNav(page).getByRole("link", { name: "Agenda", exact: true }).click();
  await expect(page).toHaveURL(/\/admin\/agenda$/);
  await expect(page.getByText("Nothing here yet")).toBeVisible();
  await expect(page.getByText("Sessions will appear here in list view", { exact: false })).toBeVisible();
  await expect(page.getByText(PRIMARY_SESSION, { exact: false })).toHaveCount(0);
  await expect(switcher(page)).toHaveAttribute("data-current-event", NEW_SLUG);

  await switcher(page).getByLabel("Event").selectOption(PRIMARY_SLUG);
  await page.getByRole("button", { name: "Switch event" }).click();
  await expect(switcher(page)).toHaveAttribute("data-current-event", PRIMARY_SLUG);
  await expect(page.getByRole("banner")).toContainText(PRIMARY_NAME);
  await expect(page.getByText(PRIMARY_SESSION, { exact: false }).first()).toBeVisible();
});
