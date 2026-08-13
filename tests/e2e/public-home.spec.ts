/**
 * The self-proving embed on the public home page.
 *
 * Every other surface can only CLAIM the embed area works. This one frames the
 * real widget route, so the test that matters is the one that reaches THROUGH
 * the iframe and finds the seeded agenda inside it — a broken widget, a wrong
 * slug or a framing header that forbids it all fail here while the markup-level
 * unit test would still pass.
 */
import { expect, test } from "@playwright/test";

const EVENT_SLUG = "frontier-ai-summit-2026";
const FRAME = '[data-testid="home-embed-iframe"]';

test("the home page frames its own agenda widget, and the widget renders inside it", async ({
  page,
}) => {
  await page.goto("/");

  const section = page.getByTestId("home-embed-proof");
  const frame = page.locator(FRAME);

  // The copy is the claim; the frame below it is the evidence.
  await expect(section).toContainText("This is the live embed");
  await expect(section).toContainText("an organizer pastes");

  // Lazily loaded, because it sits below the events list.
  await expect(frame).toHaveAttribute("loading", "lazy");
  await expect(frame).toHaveAttribute(
    "src",
    `/embed/${EVENT_SLUG}/agenda?theme=auto`,
  );

  // Scrolled into view before reaching through it: how near the viewport a
  // browser begins fetching a lazy frame is implementation-defined, so the test
  // must not depend on it having already started.
  await frame.scrollIntoViewIfNeeded();

  // THROUGH the iframe: the real widget, with the real seeded agenda in it.
  const inside = page.frameLocator(FRAME);
  await expect(inside.locator("[data-embed-agenda-day]").first()).toBeVisible();
  await expect(inside.getByTestId("embed-agenda")).toHaveAttribute(
    "data-embed-theme",
    "auto",
  );
  // Chrome-less, as an embed must be: the host page supplies its own nav, and a
  // second one inside the frame reads as a broken page.
  await expect(inside.locator("header nav")).toHaveCount(0);
});

test("the framed URL is the one an organizer would paste, and it permits framing", async ({
  browser,
  baseURL,
}) => {
  const context = await browser.newContext({ baseURL });
  const page = await context.newPage();

  // Same URL, opened directly: 200, and the framing exception is on it. If this
  // ever regressed to `frame-ancestors 'none'` the home page would render an
  // empty box and no unit test would notice.
  const response = await page.goto(`/embed/${EVENT_SLUG}/agenda?theme=auto`);
  expect(response?.status()).toBe(200);
  expect(response?.headers()["content-security-policy"]).toContain("frame-ancestors *");
  expect(response?.headers()["x-frame-options"]).toBeUndefined();

  // MUST NOT FIRE: the home page itself stays frame-denied. The exception is
  // scoped to /embed, not widened to the public site by adding this section.
  const home = await page.goto("/");
  expect(home?.headers()["x-frame-options"]).toBe("DENY");

  await context.close();
});
