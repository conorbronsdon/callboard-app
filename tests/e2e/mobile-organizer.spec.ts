/**
 * Narrow-screen organizer smoke.
 *
 * The release lane already executes the public CFP golden path at 375px and
 * keeps agenda drag-and-drop at a deliberate laptop viewport. This test covers
 * the missing seam between those two facts: a judge entering the seeded demo
 * on a phone can reach the organizer's critical surfaces through the real
 * admin navigation, inspect the accepted/task-backed state, and use the agenda
 * List view without the document itself scrolling sideways.
 *
 * Keep this a smoke journey. Detailed mutations belong to their focused route
 * and database suites; repeating them here would make the release gate slower
 * without adding responsive evidence.
 */
import { expect, test, type Page } from "@playwright/test";

async function expectPhoneLayout(page: Page) {
  expect(page.viewportSize()).toEqual({ width: 375, height: 812 });
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow, "the 375px organizer page must not scroll sideways").toBeLessThanOrEqual(1);
}

async function adminNav(page: Page) {
  const nav = page.locator("header nav");
  await expect(nav).toBeVisible();
  return nav;
}

test("mobile judge can enter the demo and navigate the organizer workflow", async ({ page }) => {
  await page.goto("/demo");
  await expect(page.getByRole("heading", { name: "Judge demo" })).toBeVisible();
  await expectPhoneLayout(page);

  await page.getByRole("button", { name: "Enter organizer workspace", exact: true }).click();
  await expect(page).toHaveURL(/\/admin$/);
  await expectPhoneLayout(page);

  // Seeded acceptance has already composed a programme session and speaker
  // tasks. These positive dashboard counts prove the phone journey is walking
  // that judge-critical state, not an empty shell.
  for (const label of ["Accepted abstracts", "Outstanding speaker tasks"]) {
    const card = page.getByRole("link").filter({ hasText: label });
    await expect(card).toBeVisible();
    const count = Number(await card.locator("dd").innerText());
    expect(count, `${label} should have seeded data`).toBeGreaterThan(0);
  }

  // Grouping makes the organizer nav short enough to wrap at 375px. The strip
  // and the page both stay fixed-width while every disclosure remains usable.
  const firstNav = await adminNav(page);
  const navOverflow = await firstNav.evaluate((node) => node.scrollWidth - node.clientWidth);
  expect(navOverflow, "admin nav should not scroll sideways").toBeLessThanOrEqual(1);

  await page.getByTestId("admin-nav-group-cfp").locator("summary").click();
  await firstNav.getByRole("link", { name: "Forms", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Submission forms" })).toBeVisible();
  await expect(page.getByText("to review").first()).toBeVisible();
  await expectPhoneLayout(page);

  await page.getByTestId("admin-nav-group-review").locator("summary").click();
  await (await adminNav(page)).getByRole("link", { name: "Review ops", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Review operations" })).toBeVisible();
  // Renamed from "Reviewer teams" with ABS-02: reviewer pools are per ROUND,
  // and the round cards derive theirs from whichever committee holds that
  // round's assignments — so the global list had to stop reading as "the"
  // reviewer list. The per-round block below is the other half of that model.
  await expect(
    page.getByRole("heading", { name: "Committees (shared across rounds)" }),
  ).toBeVisible();
  await expect(page.getByRole("heading", { name: /Round 1 reviewer pool/ })).toBeVisible();
  await expectPhoneLayout(page);

  await page.getByTestId("admin-nav-group-programme").locator("summary").click();
  await (await adminNav(page)).getByRole("link", { name: "Submissions", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Abstracts" })).toBeVisible();
  await page.getByRole("link", { name: /^Accepted \d+$/ }).click();
  await expect(page).toHaveURL(/tab=accepted/);
  await expect(page.locator("tbody tr").first()).toBeVisible();
  await expectPhoneLayout(page);

  // Dragging a dense room×time board is a laptop interaction (covered by the
  // dedicated DnD spec). List view is the stable, useful phone interaction.
  await (await adminNav(page)).getByRole("link", { name: "Agenda", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Agenda" })).toBeVisible();
  await page.locator('[data-view-tab="list"]').click();
  await expect(page).toHaveURL(/view=list/);
  await expect(page.locator("[data-session-row]").first()).toBeVisible();
  await expectPhoneLayout(page);
});
