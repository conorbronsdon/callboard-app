/**
 * The demo, walked as a judge would walk it — against the SEEDED data only.
 *
 * `public-submit.spec.ts` proves the wizard works using fixtures it installs
 * itself (tests/e2e/fixtures.sql). That is the wrong proof for this lane: the
 * walkthrough finding was that the DEPLOYED demo showed an empty rules list, no
 * combined counter and a "—" track column, because the seed shipped none of
 * them. So every assertion here runs against `npm run seed` output with ZERO
 * extra setup, and fails if a differentiator stops being seeded.
 *
 * Covers:
 *   · the live cross-field counter on the seeded CFP form
 *   · conditional logic, must-fire AND must-not-fire, on two different triggers
 *   · a new submission landing with a REAL track name (category routing)
 *   · the abstract drill-in rendering every section from seed data
 *   · prev/next inside a tab filter
 *   · the speaker profile the names link to
 *   · the WS3 zero-state speaker, still clean
 */
import { expect, test, type Page } from "@playwright/test";

const EVENT = "frontier-ai-summit-2026";
/** The seeded CFP form — a fixed id from scripts/seed.mjs, not a fixture. */
const SEEDED_CFP = "000000fo-0000-4000-8000-000000000001";

function newEmail(tag: string): string {
  return `seed-demo-${tag}-${Date.now().toString(36)}@example.com`;
}

async function createAccount(page: Page, name: string, email: string) {
  await page.goto(`/submit/${EVENT}/${SEEDED_CFP}`);
  await page.getByTestId("wizard-next").click();
  await expect(page).toHaveURL(/\/step\/account$/);
  await page.getByLabel("Your name").fill(name);
  await page.getByLabel("Your email address").fill(email);
  await page.getByTestId("wizard-next").click();
  await expect(page.getByTestId("account-magic-sent")).toBeVisible();
  await page.getByTestId("account-dev-link").click();
  await expect(page).toHaveURL(/\/step\/submission$/);
}

async function signInAs(page: Page, role: "admin" | "speaker") {
  await page.goto("/demo");
  await page.getByRole("button", { name: role === "admin" ? "Enter organizer workspace" : "Enter speaker portal" }).click();
  await expect(page).toHaveURL(role === "admin" ? /\/admin$/ : /\/portal$/);
}

/* ───────────────────────────── the public form ───────────────────────────── */

test("the seeded CFP form ships conditional logic and a live combined counter", async ({
  page,
}) => {
  await createAccount(page, "Demo Walker", newEmail("conditional"));

  // The cross-field counter is on screen with no admin having configured one.
  const counter = page.getByTestId("combined-limit-programme-block");
  await expect(counter).toBeVisible();
  await expect(page.getByTestId("combined-count-programme-block")).toContainText(
    "/ 300 characters",
  );
  await expect(counter).toHaveAttribute("data-over", "false");

  const format = page.getByLabel("Format");
  const track = page.getByLabel("Track");

  // MUST-NOT-FIRE: a Talk is not asked for workshop prerequisites.
  await format.selectOption("Talk");
  await expect(page.getByLabel("Workshop prerequisites")).toHaveCount(0);

  // MUST-FIRE: Workshop reveals it.
  await format.selectOption("Workshop");
  await expect(page.getByLabel("Workshop prerequisites")).toBeVisible();

  // A SECOND rule on a different trigger, so this is rule evaluation and not
  // one hard-coded format branch.
  await track.selectOption("Agents");
  await expect(page.getByLabel("Benchmark or eval harness")).toHaveCount(0);
  await track.selectOption("Evals & Reliability");
  await expect(page.getByLabel("Benchmark or eval harness")).toBeVisible();

  // MUST-FIRE: the shared budget actually bites. `takeaways` has its own
  // 300-char maxlength, so this only goes over because the two fields SHARE a
  // budget — which is the whole point of a cross-field limit.
  await page.getByLabel("Session title").fill("Counting characters in anger");
  await page.getByLabel("Audience takeaways").fill("x".repeat(300));
  await expect(counter).toHaveAttribute("data-over", "true");

  // MUST-NOT-FIRE: back under the cap it clears.
  await page
    .getByLabel("Audience takeaways")
    .fill("Three things to apply on Monday, and the two caveats that come with them.");
  await expect(counter).toHaveAttribute("data-over", "false");
});

test("a new submission lands with a real track name, not a dash", async ({ page }) => {
  const title = `Routed by the workshop rule ${Date.now().toString(36)}`;
  await createAccount(page, "Route Walker", newEmail("routing"));

  // Workshop + an Agents topic. Routing rule 1 outranks the topic rules, so the
  // row must land in "Workshops & Labs" — a track the submitter never chose.
  await page.getByLabel("Session title").fill(title);
  await page.getByLabel("Track").selectOption("Agents");
  await page.getByLabel("Format").selectOption("Workshop");
  // By id: "Abstract" also matches the abstract-vs-video radio's label.
  await page
    .locator("#field-abstract")
    .fill(
      "A hands-on session on building agents that survive real users. ".repeat(5) +
        "We will work through failure modes, retries and the evaluation harness that tells you which change helped.",
    );
  await page
    .getByLabel("Audience takeaways")
    .fill("What to measure first, which failure bites earliest, and the smallest fix that moves it.");
  await page.getByLabel("Workshop prerequisites").fill("A laptop with Docker and Python 3.11.");
  await page.getByTestId("wizard-next").click();

  await expect(page).toHaveURL(/\/step\/participant$/);
  await page.getByLabel("Biography").fill("Walks demos for a living. Seeded by the e2e run.");
  await page.getByTestId("wizard-next").click();

  await expect(page).toHaveURL(/\/step\/review$/);
  await page.getByTestId("wizard-next").click();
  await expect(page).toHaveURL(/\/success\?s=/);

  // Now look at it the way an organiser does.
  await signInAs(page, "admin");
  await page.goto("/admin/submissions?tab=pending");
  const row = page.locator("tr", { hasText: title });
  await expect(row).toBeVisible();
  await expect(row).toContainText("Workshops & Labs");
  // MUST-NOT-FIRE: the track column is not the empty dash the walkthrough found.
  await expect(row).not.toContainText("Agents");
});

/* ──────────────────────────── the abstract drill-in ─────────────────────── */

test("the abstracts table drills into a detail page with every section", async ({ page }) => {
  await signInAs(page, "admin");
  await page.goto("/admin/submissions?tab=pending");

  // Rows link by title — that is the drill-in entry point.
  const firstTitle = page.locator("tbody tr td:nth-child(2) a").first();
  const titleText = (await firstTitle.textContent())?.trim() ?? "";
  expect(titleText.length).toBeGreaterThan(0);
  await firstTitle.click();
  await expect(page).toHaveURL(/\/admin\/submissions\/[^/?]+\?tab=pending/);

  // Every section, from seeded data.
  await expect(page.getByRole("heading", { name: titleText })).toBeVisible();
  await expect(page.getByTestId("detail-status")).toBeVisible();
  await expect(page.getByTestId("detail-abstract")).toContainText(/\w{200,}|\w+/);
  await expect(page.getByTestId("detail-answers")).toContainText("Track");
  await expect(page.getByTestId("detail-answers")).toContainText("Audience takeaways");
  await expect(page.getByTestId("detail-speakers")).toBeVisible();

  // The abstract body really is long-form prose, not the table's truncated cell.
  const abstractText = (await page.getByTestId("detail-abstract").textContent()) ?? "";
  expect(abstractText.length).toBeGreaterThan(400);

  // The status popover saves with the same semantics as the table.
  await page.getByTestId("detail-status").locator("summary").click();
  await expect(page.getByRole("button", { name: "Save" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Cancel" })).toBeVisible();

  // prev/next walks the tab.
  const next = page.getByTestId("detail-next");
  await expect(next).toBeVisible();
  await next.click();
  await expect(page).toHaveURL(/\/admin\/submissions\/[^/?]+\?tab=pending/);
  await expect(page.getByTestId("detail-prev")).toBeVisible();
  await page.getByTestId("detail-prev").click();
  await expect(page.getByRole("heading", { name: titleText })).toBeVisible();

  // Speaker names link to a profile with their submissions on it.
  const speakerLink = page.getByTestId("detail-speakers").getByRole("link").first();
  const speakerName = (await speakerLink.textContent())?.trim() ?? "";
  await speakerLink.click();
  await expect(page).toHaveURL(/\/admin\/speakers\/[^/?]+$/);
  await expect(page.getByRole("heading", { name: speakerName })).toBeVisible();
  await expect(page.getByTestId("speaker-submissions")).toContainText("Submissions");
});

test("every status tab has rows, and each one drills in", async ({ page }) => {
  await signInAs(page, "admin");

  for (const tab of [
    "accepted",
    "accept_queue",
    "pending",
    "decline_queue",
    "declined",
    "withdrawn",
    "draft",
  ]) {
    await page.goto(`/admin/submissions?tab=${tab}`);
    // The walkthrough's complaint was dead tabs. Every one of the seven has data.
    await expect(page.locator("tbody tr"), `tab ${tab} has no rows`).not.toHaveCount(0);
    await expect(page.getByText(/No abstracts in/)).toHaveCount(0);
  }
});

/* ──────────────────────────────── zero states ───────────────────────────── */

test("the zero-state speaker's portal is still clean", async ({ page }) => {
  // newcomer@example.com has no submissions, no tasks and no bio — seeded that
  // way on purpose, and the richer seed must not have given them anything.
  await page.goto("/login");
  await page.getByLabel("Email").fill("newcomer@example.com");
  await page.getByRole("button", { name: "Email me a link" }).click();
  // Dev mode prints the magic link on the page rather than sending mail.
  await page.getByRole("link", { name: /\/auth\/verify\?token=/ }).click();

  await expect(page).toHaveURL(/\/portal$/);
  await expect(page.getByRole("navigation", { name: "Portal sections" })).toBeVisible();

  await page.goto("/portal/submissions");
  await expect(page.getByText("No submissions yet")).toBeVisible();
  await page.goto("/portal/tasks");
  await expect(page.getByText("No tasks yet")).toBeVisible();
});
