/**
 * Two working routes nothing navigated to.
 *
 * `/admin/view-as` and `/review` were both registered, both functional, and
 * both absent from the thirteen-item admin nav — README advertises the signed
 * "view as reviewer" path, and the only way to reach it was to type the URL.
 * A judge does not type URLs.
 *
 * This walks the nav rather than visiting the paths directly: `page.goto` would
 * pass with no links at all, which is precisely the state being fixed.
 */
import { expect, test, type Page } from "@playwright/test";

const SECOND_SLUG = "frontier-ai-summit-europe-2026";

async function enterOrganizerWorkspace(page: Page) {
  await page.goto("/demo");
  await page.getByRole("button", { name: "Enter organizer workspace", exact: true }).click();
  await expect(page).toHaveURL(/\/admin$/);
}

function adminNav(page: Page) {
  return page.locator("header nav");
}

test("the organizer nav reaches the impersonation launcher and the reviewer workspace", async ({
  page,
}) => {
  await enterOrganizerWorkspace(page);

  await adminNav(page).getByRole("link", { name: "View as", exact: true }).click();
  await expect(page).toHaveURL(/\/admin\/view-as$/);
  await expect(page.getByRole("heading", { name: "View as speaker" })).toBeVisible();
  // Both preview tables are on the page — the reviewer one is the path README
  // calls "view as reviewer".
  await expect(page.getByRole("button", { name: "View as reviewer" }).first()).toBeVisible();
  await expect(page.getByRole("button", { name: "View as speaker" }).first()).toBeVisible();

  await enterOrganizerWorkspace(page);

  await adminNav(page).getByRole("link", { name: "Reviewer workspace", exact: true }).click();
  await expect(page).toHaveURL(/\/review\?event=/);
  // The reviewer chrome, reached through team membership rather than a fallback
  // guess: the seeded organizer is on every review team.
  await expect(page.getByText("Assigned abstracts only")).toBeVisible();
});

test("the reviewer-workspace link carries the event the organizer has selected", async ({
  page,
}) => {
  // MUST FIRE the other way too: `/review` is the one nav destination outside
  // `/admin`, so it never receives the selection cookie. A bare href would send
  // an organizer working on the second event into the oldest reviewed one.
  await enterOrganizerWorkspace(page);

  const link = adminNav(page).getByRole("link", { name: "Reviewer workspace", exact: true });
  await expect(link).toHaveAttribute("href", "/review?event=frontier-ai-summit-2026");

  await page.getByLabel("Event").selectOption(SECOND_SLUG);
  await page.getByRole("button", { name: "Switch event" }).click();
  await expect(page.locator("[data-testid=admin-event-switcher]")).toHaveAttribute(
    "data-current-event",
    SECOND_SLUG,
  );

  await expect(link).toHaveAttribute("href", `/review?event=${SECOND_SLUG}`);
  await link.click();
  await expect(page.getByText("Assigned abstracts only")).toBeVisible();
  await expect(page.getByRole("banner")).toContainText("Frontier AI Summit Europe 2026");
});
