import { expect, test } from "@playwright/test";

/**
 * Restore is wired on BOTH admin detail surfaces and each is its OWN action
 * behind its OWN `requireAdmin` guard: `/admin/sessions/:id` (programme) and
 * `/admin/submissions/:id` (abstract). session-revision-history.spec.ts proves
 * the sessions surface; the submissions surface had no authorization coverage
 * at all — this is it.
 *
 * Two paired controls on `/admin/submissions/:id` SPECIFICALLY, each proven to
 * discriminate:
 *   - MUST FIRE: an organizer POSTs restore-revision and it lands — 302 back to
 *     the abstract, exactly one appended revision (every prior id still present:
 *     append-only), and the abstract's content re-applied to the restored one.
 *   - MUST NOT FIRE: the identical body is 403 from a signed-in speaker and is
 *     bounced to /login from an anonymous client, and in NEITHER case does the
 *     abstract move — the revision id set and the title/abstract are exactly
 *     what they were before the attempt.
 *
 * The must-fire is what proves the 403/redirect is an authorization decision
 * rather than a malformed-request artifact; the unchanged-state assertions are
 * what prove the refusal actually refused the write.
 *
 * Desktop viewport: an organizer reviews an abstract on a laptop.
 */
test.use({ viewport: { width: 1440, height: 1000 } });

type Page = import("@playwright/test").Page;

async function signInAsAdmin(page: Page) {
  await page.goto("/demo");
  await page.getByRole("button", { name: "Enter organizer workspace", exact: true }).click();
  await page.waitForURL(/\/admin/);
}

function attrValues(html: string, attr: string): string[] {
  return [...html.matchAll(new RegExp(`data-${attr}="([^"]+)"`, "g"))].map((m) => m[1]);
}

interface AbstractState {
  revisionIds: string[];
  restorable: string[];
  title: string;
  abstract: string;
}

/** Everything a paired control needs to compare before/after, read as the admin. */
async function readState(page: Page, id: string): Promise<AbstractState> {
  await page.goto(`/admin/submissions/${id}`);
  const revisionIds = await page
    .locator("[data-revision-history] [data-revision-entry]")
    .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-revision-id") ?? ""));
  const restorable = await page
    .locator("[data-revision-history] [data-restore-revision]")
    .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-restore-revision") ?? ""));
  // `inputValue` reads the field even inside the collapsed <details> edit panel.
  const title = await page.locator('[data-abstract-edit-form] input[name="title"]').inputValue();
  const abstract = await page
    .locator('[data-abstract-edit-form] textarea[name="abstract"]')
    .inputValue();
  return { revisionIds, restorable, title, abstract };
}

/**
 * An accepted abstract the SEED gave multi-entry history to (a submit plus two
 * organizer edits, the earlier of which is a deliberately distinct Restore
 * target). Found by walking the submissions tabs rather than hard-coding an id,
 * so a reshuffled seed fails loudly here instead of silently retargeting.
 */
async function seededHistoryAbstractId(page: Page): Promise<string> {
  for (const tab of ["accepted", "pending", "accept_queue", "decline_queue", "declined"]) {
    const listHtml = await (await page.request.get(`/admin/submissions?tab=${tab}`)).text();
    // Seed ids are UUID-shaped but carry bucket letters (000000se-…), so the id
    // class is [0-9a-z], not hex. The trailing `?tab=…` and non-id links like
    // /admin/submissions/scores.csv fall outside this shape and are ignored.
    const ids = [
      ...new Set(
        [
          ...listHtml.matchAll(
            /\/admin\/submissions\/([0-9a-z]{8}-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{12})/g,
          ),
        ].map((m) => m[1]),
      ),
    ];
    for (const id of ids) {
      const detail = await (await page.request.get(`/admin/submissions/${id}`)).text();
      // >= 2 entries means at least one is non-current and therefore restorable.
      if (attrValues(detail, "revision-id").length >= 2 && attrValues(detail, "restore-revision").length >= 1) {
        return id;
      }
    }
  }
  throw new Error(
    "No seeded abstract carries a restorable revision — the /admin/submissions restore path would demo empty.",
  );
}

test("an organizer can restore an abstract revision, and it appends rather than replaces", async ({
  page,
}) => {
  await signInAsAdmin(page);
  const id = await seededHistoryAbstractId(page);
  const path = `/admin/submissions/${id}`;

  const before = await readState(page, id);
  expect(before.revisionIds.length).toBeGreaterThanOrEqual(2);
  expect(before.restorable.length).toBeGreaterThanOrEqual(1);
  // The newest restorable entry is the seed's distinct earlier version, chosen
  // so a successful restore visibly changes the abstract's content.
  const target = before.restorable[0];

  const restored = await page.request.post(path, {
    form: { intent: "restore-revision", revisionId: target, tab: "accepted", track: "" },
    maxRedirects: 0,
  });
  expect(restored.status()).toBe(302);
  expect(restored.headers()["location"]).toContain(`/admin/submissions/${id}`);

  const after = await readState(page, id);
  // Append-only: exactly one new entry, and every prior id survives. A restore
  // implemented as "delete the newer rows" would shrink this, not grow it.
  expect(after.revisionIds.length).toBe(before.revisionIds.length + 1);
  for (const rid of before.revisionIds) expect(after.revisionIds).toContain(rid);
  // The content path actually ran: the abstract is no longer what it was, which
  // a no-op "restore" that returned 302 without writing could not produce.
  expect(after.title === before.title && after.abstract === before.abstract).toBe(false);

  // Leave the abstract's live content as we found it — this suite shares one
  // database and later specs read the seeded content. (The appended history
  // rows stay; history is append-only by design.)
  const reset = await page.request.post(path, {
    form: {
      intent: "edit-abstract",
      title: before.title,
      abstract: before.abstract,
      tab: "accepted",
      track: "",
    },
    maxRedirects: 0,
  });
  expect(reset.status()).toBe(302);
  const restoredBack = await readState(page, id);
  expect(restoredBack.title).toBe(before.title);
  expect(restoredBack.abstract).toBe(before.abstract);
});

test("restoring an abstract revision is organizer-only, and a refusal applies nothing", async ({
  page,
  request,
  browser,
}) => {
  await signInAsAdmin(page);
  const id = await seededHistoryAbstractId(page);
  const path = `/admin/submissions/${id}`;
  const origin = new URL(page.url()).origin;

  const before = await readState(page, id);
  const target = before.restorable[0];
  expect(target, "a restorable revision to aim the refused POST at").toBeTruthy();

  /* Anonymous: bounced to sign-in, never applied. */
  const anonymous = await request.post(path, {
    form: { intent: "restore-revision", revisionId: target, tab: "accepted", track: "" },
    maxRedirects: 0,
  });
  expect([302, 303, 401, 403]).toContain(anonymous.status());
  if (anonymous.status() === 302 || anonymous.status() === 303) {
    expect(anonymous.headers()["location"]).toContain("/login");
  }

  /* A signed-in SPEAKER: 403, not a redirect — the role is the refusal. */
  const speakerContext = await browser.newContext({ baseURL: origin });
  try {
    const speaker = await speakerContext.newPage();
    await speaker.goto("/demo");
    await speaker.getByRole("button", { name: "Enter speaker portal", exact: true }).click();
    await speaker.waitForURL(/\/portal/);
    const refused = await speaker.request.post(path, {
      form: { intent: "restore-revision", revisionId: target, tab: "accepted", track: "" },
      maxRedirects: 0,
    });
    expect(refused.status()).toBe(403);
  } finally {
    await speakerContext.close();
  }

  /*
   * Nothing applied: neither refusal moved the abstract. The revision id set is
   * identical (no append) and the live content is byte-for-byte unchanged.
   */
  const after = await readState(page, id);
  expect(after.revisionIds).toEqual(before.revisionIds);
  expect(after.title).toBe(before.title);
  expect(after.abstract).toBe(before.abstract);

  /*
   * MUST-FIRE control: the identical body, posted by the organizer, IS accepted
   * and DOES append. Without this the refusals above could be a malformed-body
   * artifact rather than an authorization decision.
   */
  const allowed = await page.request.post(path, {
    form: { intent: "restore-revision", revisionId: target, tab: "accepted", track: "" },
    maxRedirects: 0,
  });
  expect(allowed.status()).toBe(302);
  expect(allowed.headers()["location"]).toContain(`/admin/submissions/${id}`);
  const applied = await readState(page, id);
  expect(applied.revisionIds.length).toBe(before.revisionIds.length + 1);

  // Reset the live content for later specs; history rows remain (append-only).
  await page.request.post(path, {
    form: {
      intent: "edit-abstract",
      title: before.title,
      abstract: before.abstract,
      tab: "accepted",
      track: "",
    },
    maxRedirects: 0,
  });
});
