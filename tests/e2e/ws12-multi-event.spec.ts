/**
 * WS12 — multi-event administration, walked the way an organizer would.
 *
 * The load-bearing assertion is not "switching changes the page". It is that
 * the selection SURVIVES a plain nav click: the URLs below carry no `?event=`,
 * so if the cookie were not being written (or not being read) the second and
 * third pages would silently fall back to the default event. That is the exact
 * failure a query-param-only implementation ships with, and the reason the
 * `toHaveURL(/\/admin\/submissions$/)` checks are written without a query
 * string rather than with `.*`.
 *
 * The default event is asserted first and last: every other spec in this suite
 * is written against `frontier-ai-summit-2026` being what an organizer sees on
 * arrival, and the second seeded event must not have moved that.
 */
import { expect, test, type Page } from "@playwright/test";

const PRIMARY_SLUG = "frontier-ai-summit-2026";
const PRIMARY_NAME = "Frontier AI Summit 2026";
const SECOND_SLUG = "frontier-ai-summit-europe-2026";
const SECOND_NAME = "Frontier AI Summit Europe 2026";

/** Abstracts that exist on exactly one of the two seeded events. */
const SECOND_ONLY_ABSTRACT = "Retrieval that survives four languages";
const SECOND_ONLY_SPEAKER = "Ines Duarte";
const PRIMARY_ONLY_SPEAKER = "Sam Speaker";

function switcher(page: Page) {
  return page.getByTestId("admin-event-switcher");
}

async function switchTo(page: Page, slug: string) {
  await switcher(page).getByLabel("Event").selectOption(slug);
  await page.getByRole("button", { name: "Switch event" }).click();
  await expect(switcher(page)).toHaveAttribute("data-current-event", slug);
}

test("an organizer switches events and the selection follows plain nav clicks", async ({
  page,
}) => {
  await page.goto("/demo");
  await page.getByRole("button", { name: "Enter organizer workspace", exact: true }).click();
  await expect(page).toHaveURL(/\/admin$/);

  // The switcher only appears because the seed now ships two events.
  await expect(switcher(page)).toBeVisible();
  await expect(switcher(page)).toHaveAttribute("data-current-event", PRIMARY_SLUG);
  await expect(page.getByRole("banner")).toContainText(PRIMARY_NAME);

  const submissionsCount = page
    .getByRole("link")
    .filter({ hasText: "Submissions" })
    .locator("dd")
    .first();
  const primaryAbstracts = Number(await submissionsCount.innerText());
  // The seeded Frontier AI Summit CFP is 30 abstracts; the Europe event is 3. The
  // exact number matters less than the two being different, which is what makes
  // the post-switch count evidence rather than coincidence.
  expect(primaryAbstracts).toBeGreaterThan(10);

  /* ── switch ─────────────────────────────────────────────────────────── */

  await switchTo(page, SECOND_SLUG);
  await expect(page).toHaveURL(/\/admin$/);
  await expect(page.getByRole("banner")).toContainText(SECOND_NAME);
  await expect(submissionsCount).toHaveText("3");

  /* ── two plain nav clicks, no query params ──────────────────────────── */

  await page.locator("header nav").getByRole("link", { name: "Submissions", exact: true }).click();
  await expect(page).toHaveURL(/\/admin\/submissions$/);
  // Loader-derived content FIRST. React Router keeps the previous page mounted
  // while the next one's loaders run, so a chrome attribute can briefly still
  // read the old value — asserting the new page's rows first makes the checks
  // below unambiguous.
  await expect(page.locator("tbody")).toContainText(SECOND_ONLY_ABSTRACT);
  await expect(page.getByRole("banner")).toContainText(SECOND_NAME);
  await expect(switcher(page)).toHaveAttribute("data-current-event", SECOND_SLUG);

  await page.locator("header nav").getByRole("link", { name: "Speakers", exact: true }).click();
  await expect(page).toHaveURL(/\/admin\/speakers$/);
  await expect(page.getByText(SECOND_ONLY_SPEAKER)).toBeVisible();
  // MUST NOT FIRE: the other event's roster does not bleed through.
  await expect(page.getByText(PRIMARY_ONLY_SPEAKER)).toHaveCount(0);
  await expect(switcher(page)).toHaveAttribute("data-current-event", SECOND_SLUG);

  /* ── switch back, from a page that is not the dashboard ─────────────── */

  await switchTo(page, PRIMARY_SLUG);
  await expect(page).toHaveURL(/\/admin\/speakers$/);
  await expect(page.getByText(PRIMARY_ONLY_SPEAKER)).toBeVisible();
  await expect(page.getByText(SECOND_ONLY_SPEAKER)).toHaveCount(0);

  await page.locator("header nav").getByRole("link", { name: "Dashboard", exact: true }).click();
  await expect(page.getByRole("banner")).toContainText(PRIMARY_NAME);
});

test("the seeded default event is unchanged for an organizer who never switches", async ({
  page,
}) => {
  // A fresh context has no selection cookie. Every other spec in this suite
  // depends on this being the Frontier AI Summit.
  await page.goto("/demo");
  await page.getByRole("button", { name: "Enter organizer workspace", exact: true }).click();
  await expect(page.getByRole("banner")).toContainText(PRIMARY_NAME);
  await expect(page.getByRole("banner")).not.toContainText(SECOND_NAME);

  await page.goto("/admin/agenda");
  await expect(page.getByRole("heading", { name: "Agenda" })).toBeVisible();
  await expect(switcher(page)).toHaveAttribute("data-current-event", PRIMARY_SLUG);
});

test("the switcher is organizer chrome only — no speaker or public surface offers it", async ({
  page,
}) => {
  await page.goto("/demo");
  await page.getByRole("button", { name: "Enter speaker portal", exact: true }).click();
  await expect(page).toHaveURL(/\/portal$/);
  await expect(switcher(page)).toHaveCount(0);

  await page.goto("/portal/tasks");
  await expect(switcher(page)).toHaveCount(0);

  await page.goto(`/e/${PRIMARY_SLUG}`);
  await expect(switcher(page)).toHaveCount(0);
});
