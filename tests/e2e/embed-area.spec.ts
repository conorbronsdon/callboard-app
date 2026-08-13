import { expect, test, type Page } from "@playwright/test";

const EVENT_SLUG = "frontier-ai-summit-2026";
/*
 * A per-run suffix, not a literal constant. `workers: 1` means these tests
 * run one at a time, but a test that fails PART way through a save can still
 * leave a real row behind — Playwright does not roll back the D1 write just
 * because a later assertion in the SAME test timed out. Two spec-level tests
 * saving under fixed names is exactly the shape of state a partially-failed
 * neighbor can collide with; a random suffix means "Partner site schedule"
 * from a prior, incomplete run can never be mistaken for this run's row, so
 * `toContainText`/`hasText` matches stay unambiguous regardless of what a
 * failure elsewhere in this file left lying around.
 */
const RUN_ID = Math.random().toString(36).slice(2, 8);
const SAVED_NAME = `Partner site schedule ${RUN_ID}`;
const DISABLED_NAME = `Disabled gate schedule ${RUN_ID}`;

async function enterOrganizerWorkspace(page: Page) {
  await page.goto("/demo");
  await page.getByRole("button", { name: "Enter organizer workspace", exact: true }).click();
  await expect(page).toHaveURL(/\/admin$/);
}

test("anonymous embed renders without chrome and permits framing", async ({ browser, baseURL }) => {
  const context = await browser.newContext({ baseURL });
  const page = await context.newPage();
  const response = await page.goto(`/embed/${EVENT_SLUG}/schedule`);

  expect(response?.status()).toBe(200);
  await expect(page.getByText("Building LLM Infrastructure That Scales")).toBeVisible();
  await expect(page.locator("header nav")).toHaveCount(0);
  await expect(page.getByText("Run a call for proposals end to end.")).toHaveCount(0);
  expect(response?.headers()["content-security-policy"]).toContain("frame-ancestors *");
  expect(response?.headers()["x-frame-options"]).toBeUndefined();
  await context.close();
});

test("anonymous speakers embed renders without chrome and permits framing", async ({
  browser,
  baseURL,
}) => {
  const context = await browser.newContext({ baseURL });
  const page = await context.newPage();
  const response = await page.goto(`/embed/${EVENT_SLUG}/speakers`);

  expect(response?.status()).toBe(200);
  await expect(page.locator("[data-embed-speaker]").first()).toBeVisible();
  await expect(page.locator("header nav")).toHaveCount(0);
  await expect(page.getByText("Run a call for proposals end to end.")).toHaveCount(0);
  expect(response?.headers()["content-security-policy"]).toContain("frame-ancestors *");
  expect(response?.headers()["x-frame-options"]).toBeUndefined();
  await context.close();
});

test("both widget cards render and the second one is independently configurable", async ({
  page,
}) => {
  await enterOrganizerWorkspace(page);
  await page.locator("header nav").getByRole("link", { name: "Embeds", exact: true }).click();

  // Two cards now share the page: the §6C register's rule is that no two
  // controls may share an accessible name, so each is addressed by its widget.
  await page.getByLabel("Theme for Speakers").selectOption("light");
  await page.getByRole("button", { name: "Get Code for Speakers" }).click();

  const snippet = page.getByTestId("embed-snippet-speakers");
  await expect(snippet).toHaveValue(/\/embed\/[^"]+\/speakers\?theme=light/);
  // The schedule card must NOT have been configured by the speakers form.
  await expect(page.getByTestId("embed-snippet-schedule")).toHaveCount(0);
});

test("the agenda and gallery widgets render anonymously and permit framing", async ({
  browser,
  baseURL,
}) => {
  const context = await browser.newContext({ baseURL });
  const page = await context.newPage();

  for (const [path, selector] of [
    [`/embed/${EVENT_SLUG}/agenda`, "[data-embed-agenda-day]"],
    [`/embed/${EVENT_SLUG}/gallery`, "[data-embed-gallery-speaker]"],
  ] as const) {
    const response = await page.goto(path);
    expect(response?.status()).toBe(200);
    await expect(page.locator(selector).first()).toBeVisible();
    await expect(page.locator("header nav")).toHaveCount(0);
    expect(response?.headers()["content-security-policy"]).toContain("frame-ancestors *");
    expect(response?.headers()["x-frame-options"]).toBeUndefined();
  }

  await context.close();
});

test("accent and density reach the rendered widget, and an injected accent is inert", async ({
  browser,
  baseURL,
}) => {
  const context = await browser.newContext({ baseURL });
  const page = await context.newPage();

  await page.goto(`/embed/${EVENT_SLUG}/agenda?accent=%23ff6600&density=compact`);
  const shell = page.getByTestId("embed-agenda");
  await expect(shell).toHaveAttribute("data-embed-accent", "#ff6600");
  await expect(shell).toHaveAttribute("data-embed-density", "compact");
  await expect(shell).toHaveAttribute("style", /--cb-accent/);

  // MUST NOT FIRE: an accent carrying CSS is dropped by the parser, never
  // interpolated — the widget still renders and the page is not blanked.
  await page.goto(
    `/embed/${EVENT_SLUG}/agenda?accent=red%3B%7Dbody%7Bdisplay%3Anone%7D&density=full`,
  );
  await expect(page.getByTestId("embed-agenda")).toHaveAttribute("data-embed-density", "full");
  await expect(page.locator("[data-embed-accent]")).toHaveCount(0);
  await expect(page.locator("[data-embed-agenda-day]").first()).toBeVisible();
  expect(await page.content()).not.toContain("body{display:none");

  await context.close();
});

test("the gallery card emits an HTML link snippet instead of an iframe", async ({ page }) => {
  await enterOrganizerWorkspace(page);
  await page.locator("header nav").getByRole("link", { name: "Embeds", exact: true }).click();

  await page.getByLabel("Format for Speaker gallery").selectOption("html");
  await page.getByLabel("Accent colour for Speaker gallery").fill("#ff6600");
  await page.getByRole("button", { name: "Get Code for Speaker gallery" }).click();

  const snippet = page.getByTestId("embed-snippet-gallery");
  await expect(snippet).toHaveValue(/<a href="/);
  await expect(snippet).toHaveValue(/accent=%23ff6600/);
  await expect(snippet).not.toHaveValue(/<iframe/);
});

test("the public schedule remains frame-denied", async ({ browser, baseURL }) => {
  const context = await browser.newContext({ baseURL });
  const page = await context.newPage();
  const response = await page.goto(`/e/${EVENT_SLUG}/schedule`);

  expect(response?.status()).toBe(200);
  expect(response?.headers()["x-frame-options"]).toBe("DENY");
  await context.close();
});

test("organizer reaches Embeds through nav, captures code, and saves it", async ({ page }) => {
  await enterOrganizerWorkspace(page);

  await page.locator("header nav").getByRole("link", { name: "Embeds", exact: true }).click();
  await expect(page).toHaveURL(/\/admin\/embeds$/);
  await page.getByLabel("Theme for Schedule").selectOption("dark");
  await page.getByLabel("Track for Schedule").selectOption("Agents");
  await page.getByRole("button", { name: "Get Code for Schedule" }).click();

  const snippet = page.getByTestId("embed-snippet-schedule");
  await expect(snippet).toHaveValue(/<iframe src="/);
  await expect(snippet).toHaveValue(/theme=dark/);
  await page.getByLabel("Name for Schedule").fill(SAVED_NAME);
  await page.getByRole("button", { name: "Save this embed for Schedule", exact: true }).click();
  await expect(page.getByTestId("saved-embeds")).toContainText(SAVED_NAME);
});

test("disabling a saved embed makes its live handle return 404", async ({ page }) => {
  await enterOrganizerWorkspace(page);
  await page.locator("header nav").getByRole("link", { name: "Embeds", exact: true }).click();

  await page.getByLabel("Name for Schedule").fill(DISABLED_NAME);
  await page.getByRole("button", { name: "Save this embed for Schedule", exact: true }).click();
  const row = page.getByTestId("saved-embeds").locator("article", { hasText: DISABLED_NAME });
  await expect(row).toBeVisible();
  const liveUrl = await row.locator('a[href*="?embed="]').getAttribute("href");
  expect(liveUrl).toBeTruthy();
  await row.getByRole("button", { name: `Disable ${DISABLED_NAME}` }).click();
  await expect(row).toContainText("Disabled");

  const response = await page.goto(liveUrl!);
  expect(response?.status()).toBe(404);
});

test("the Embeds page live preview really renders the widget it claims to preview", async ({
  page,
}) => {
  await enterOrganizerWorkspace(page);
  await page.goto("/admin/embeds?w=schedule");

  const preview = page.frameLocator('[data-testid="embed-preview-schedule"]');
  await expect(preview.getByText("Building LLM Infrastructure That Scales")).toBeVisible();
  await expect(page.locator('[data-testid="embed-preview-speakers"]')).toHaveCount(0);
});

test("grab points at the dashboard, settings, and speakers pages jump straight to a rendered snippet", async ({
  page,
}) => {
  await enterOrganizerWorkspace(page);

  // Dashboard: the "Publish the agenda" and "Onboard speakers" readiness
  // stages each carry a grab link straight to that widget's snippet.
  await page.goto("/admin");
  await page.getByRole("link", { name: "Embed the agenda" }).click();
  await expect(page).toHaveURL(/\/admin\/embeds\?w=agenda$/);
  await expect(page.getByTestId("embed-snippet-agenda")).toHaveValue(/<iframe src="/);

  // Settings: the event-configuration screen links straight to the schedule
  // and speaker-directory snippets.
  await page.goto("/admin/settings");
  await page.getByRole("link", { name: "Embed the schedule" }).click();
  await expect(page).toHaveURL(/\/admin\/embeds\?w=schedule$/);
  await expect(page.getByTestId("embed-snippet-schedule")).toHaveValue(/<iframe src="/);

  // Speakers roster: the page header links to the speaker-directory snippet.
  await page.goto("/admin/speakers");
  await page.getByRole("link", { name: "Embed the speaker directory" }).click();
  await expect(page).toHaveURL(/\/admin\/embeds\?w=speakers$/);
  await expect(page.getByTestId("embed-snippet-speakers")).toHaveValue(/<iframe src="/);
});
