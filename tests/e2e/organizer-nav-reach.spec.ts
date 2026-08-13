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

import { buildAdminNav, isAdminNavGroup } from "~/lib/admin-nav";

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

  await page.getByTestId("admin-nav-group-settings").locator("summary").click();
  await adminNav(page).getByRole("link", { name: "View as", exact: true }).click();
  await expect(page).toHaveURL(/\/admin\/view-as$/);
  await expect(page.getByRole("heading", { name: "View as speaker" })).toBeVisible();
  // Both preview tables are on the page — the reviewer one is the path README
  // calls "view as reviewer".
  await expect(page.getByRole("button", { name: "View as reviewer" }).first()).toBeVisible();
  await expect(page.getByRole("button", { name: "View as speaker" }).first()).toBeVisible();

  await enterOrganizerWorkspace(page);

  await page.getByTestId("admin-nav-group-review").locator("summary").click();
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

  await page.getByTestId("admin-nav-group-review").locator("summary").click();
  const link = adminNav(page).getByRole("link", { name: "Reviewer workspace", exact: true });
  await expect(link).toHaveAttribute("href", "/review?event=frontier-ai-summit-2026");

  await page.getByLabel("Event").selectOption(SECOND_SLUG);
  await page.getByRole("button", { name: "Switch event" }).click();
  await expect(page.locator("[data-testid=admin-event-switcher]")).toHaveAttribute(
    "data-current-event",
    SECOND_SLUG,
  );

  // The switch redirects back to a fresh /admin render, where Review is no
  // longer the active group — its <details> closes along with it, same as
  // any other non-active group. Reopen before reading the link again, the
  // same way a person would.
  await page.getByTestId("admin-nav-group-review").locator("summary").click();
  await expect(link).toHaveAttribute("href", `/review?event=${SECOND_SLUG}`);
  await link.click();
  await expect(page.getByText("Assigned abstracts only")).toBeVisible();
  await expect(page.getByRole("banner")).toContainText("Frontier AI Summit Europe 2026");
});

test("every admin nav destination is reachable through the grouped nav", async ({ page }) => {
  test.slow();
  await enterOrganizerWorkspace(page);
  const nav = buildAdminNav("/review?event=frontier-ai-summit-2026");

  for (const entry of nav) {
    if (isAdminNavGroup(entry)) {
      for (const item of entry.items) {
        await page.goto("/admin");
        await page.getByTestId(`admin-nav-group-${entry.key}`).locator("summary").click();
        await adminNav(page).getByRole("link", { name: item.label, exact: true }).click();
        const expectedPath = item.to.split("?")[0];
        await expect.poll(() => new URL(page.url()).pathname).toBe(expectedPath);
      }
    } else {
      await page.goto("/admin");
      await adminNav(page).getByRole("link", { name: entry.label, exact: true }).click();
      const expectedPath = entry.to.split("?")[0];
      await expect.poll(() => new URL(page.url()).pathname).toBe(expectedPath);
    }
  }
});

test("closed disclosure items do not interrupt the top-level keyboard order", async ({ page }) => {
  await enterOrganizerWorkspace(page);

  await adminNav(page).getByRole("link", { name: "Dashboard", exact: true }).focus();
  await page.keyboard.press("Tab");
  await expect(page.getByTestId("admin-nav-group-programme").locator("summary")).toBeFocused();
});

test("native admin disclosures remain operable with JavaScript disabled", async ({
  browser,
  baseURL,
}) => {
  const setup = await browser.newContext({ baseURL });
  const setupPage = await setup.newPage();
  await enterOrganizerWorkspace(setupPage);
  const cookies = await setup.cookies();
  await setup.close();

  const context = await browser.newContext({ baseURL, javaScriptEnabled: false });
  await context.addCookies(cookies);
  const page = await context.newPage();
  await page.goto("/admin");
  await expect(page).toHaveURL(/\/admin$/);

  const cfp = page.getByTestId("admin-nav-group-cfp");
  await expect(cfp).not.toHaveAttribute("open", "");
  await cfp.locator("summary").click();
  await expect(cfp).toHaveAttribute("open", "");
  await adminNav(page).getByRole("link", { name: "Forms", exact: true }).click();
  await expect(page).toHaveURL(/\/admin\/forms$/);

  await context.close();
});
