import { expect, test } from "@playwright/test";

/**
 * Organizer session editing, end to end: the title an organizer types reaches
 * the PUBLIC schedule, and a speaker put on two overlapping sessions raises the
 * double-booking warning on the session itself.
 *
 * Both halves are paired with their negative: the conflict banner is asserted
 * absent while the two sessions overlap but share nobody, so the assertion that
 * it appears afterwards is about the shared speaker and not about the page
 * simply always rendering a banner.
 *
 * Desktop viewport: an organizer edits the programme on a laptop.
 */
test.use({ viewport: { width: 1440, height: 1000 } });

type Page = import("@playwright/test").Page;

const DAY = "2026-10-08";

async function signInAsAdmin(page: Page) {
  await page.goto("/demo");
  await page.getByRole("button", { name: "Enter organizer workspace", exact: true }).click();
  await page.waitForURL(/\/admin/);
}

function attrValues(html: string, attr: string): string[] {
  return [...html.matchAll(new RegExp(`data-${attr}="([^"]+)"`, "g"))].map((m) => m[1]);
}

async function programmeIds(page: Page): Promise<string[]> {
  const html = await (await page.request.get("/admin/agenda?view=list")).text();
  const ids = attrValues(html, "session-row");
  expect(ids.length, "seeded programme sessions").toBeGreaterThanOrEqual(2);
  // The drill-in has to be REACHABLE from the agenda, not just routable.
  expect(attrValues(html, "session-edit-link")).toContain(ids[0]);
  return ids;
}

/**
 * The first programme row that is actually PUBLISHED.
 *
 * Walked rather than read off position 0: `/admin/agenda?view=list` renders the
 * Unscheduled group BEFORE the Scheduled one, so `ids[0]` is whichever accepted
 * session is still waiting for a slot — and an unscheduled session is forced
 * `is_public = false`, so it has no public page for a title edit to reach. Ask
 * each row whether it has one instead of assuming the seed's ordering.
 */
async function publishedProgrammeId(page: Page): Promise<string> {
  for (const id of await programmeIds(page)) {
    const html = await (await page.request.get(`/admin/sessions/${id}`)).text();
    if (html.includes("View on public schedule")) return id;
  }
  throw new Error("no published programme session in the seed — nothing to edit publicly");
}

/** The add-speaker picker's options: person id plus the label it shows. */
async function candidates(
  page: Page,
  sessionId: string,
): Promise<{ id: string; label: string }[]> {
  const html = await (await page.request.get(`/admin/sessions/${sessionId}`)).text();
  const select = /<select[^>]*name="personId"[^>]*>([\s\S]*?)<\/select>/.exec(html);
  if (!select) return [];
  return [...select[1].matchAll(/value="([^"]+)"[^>]*>([^<]+)</g)].map((match) => ({
    id: match[1],
    label: match[2],
  }));
}

/**
 * Place a session, and PROVE it landed.
 *
 * The response used to be fired and forgotten, which was survivable while every
 * placement was allowed. It is not survivable now: PR #152 refuses a move that
 * would double-book a room or a person (DECISIONS #70) and re-renders the board
 * with "Blocked: …" instead of redirecting. A refusal therefore left this test
 * building assertions on a programme it had never actually built — which is
 * exactly how it broke. The hard-coded 14:00 collided with a seeded Main Stage
 * session, the placement was refused, the two sessions never overlapped, and the
 * only symptom was a double-booking warning that failed to appear.
 *
 * A precondition that cannot fail out loud is not a precondition.
 */
async function scheduleAt(page: Page, sessionId: string, roomId: string, time: string) {
  const response = await page.request.post("/admin/agenda", {
    form: {
      intent: "schedule",
      sessionId,
      roomId,
      day: DAY,
      time,
      durationMinutes: "30",
      view: "list",
      returnDay: DAY,
    },
    maxRedirects: 0,
  });

  if (response.status() !== 302) {
    const reason =
      (await response.text()).match(/Blocked:[^<]{0,200}/)?.[0] ?? "(no reason on the page)";
    throw new Error(
      `scheduling ${sessionId} into room ${roomId} at ${time} was refused — ${reason}`,
    );
  }
}

/**
 * A time on DAY where EVERY one of `rooms` is empty.
 *
 * Derived from the board instead of named, because whether a given clock time is
 * free is a property of the seed rather than of the product. What this test
 * needs is not "14:00", it is "one hour in which two rooms are both available" —
 * so it asks. A slot is 30 minutes, so a 30-minute session occupies exactly the
 * cell it is dropped in and cannot spill into the next one.
 *
 * Each cell's markup runs from its own `data-slot` to its closing tag and
 * contains no nested cell, so the non-greedy match per `<td>` is exact.
 */
async function freeSharedTime(page: Page, rooms: string[], day: string): Promise<string> {
  const html = await (await page.request.get(`/admin/agenda?view=day&day=${day}`)).text();
  const byTime = new Map<string, { seen: Set<string>; taken: Set<string> }>();

  for (const match of html.matchAll(/<td[^>]*data-slot="([^"]+)"[^>]*>([\s\S]*?)<\/td>/g)) {
    // `slot|<roomId>|<day>|<time>` — four fields, and the literal prefix matters:
    // reading it as three silently made every roomId "slot", which matches no
    // room and reported the day as fully booked.
    const [, roomId, , time] = match[1].split("|");
    if (!time || !rooms.includes(roomId)) continue;
    const row = byTime.get(time) ?? { seen: new Set<string>(), taken: new Set<string>() };
    row.seen.add(roomId);
    if (match[2].includes("data-session-card")) row.taken.add(roomId);
    byTime.set(time, row);
  }

  // Map iteration is document order, so this is the earliest such time.
  for (const [time, row] of byTime) {
    if (row.seen.size === rooms.length && row.taken.size === 0) return time;
  }
  throw new Error(`no time on ${day} leaves all of ${rooms.join(", ")} free`);
}

test("an organizer's title edit reaches the public schedule", async ({ page }) => {
  await signInAsAdmin(page);
  const sessionId = await publishedProgrammeId(page);

  await page.goto(`/admin/sessions/${sessionId}`);
  const titleField = page.locator('[data-session-edit-form] input[name="title"]');
  const original = await titleField.inputValue();
  expect(original.length).toBeGreaterThan(0);

  const publicHref = await page
    .getByRole("link", { name: "View on public schedule" })
    .getAttribute("href");
  expect(publicHref, "a published session links to its public page").toBeTruthy();
  const scheduleHref = publicHref!.replace(/\/schedule\/.*$/, "/schedule");

  const renamed = "Renamed by the programme team (e2e)";
  await titleField.fill(renamed);
  await page.locator('[data-session-edit-form] button[type="submit"]').click();
  await page.waitForURL(/saved=1/);
  await expect(page.getByText("Session details saved.")).toBeVisible();

  await page.goto(scheduleHref);
  await expect(page.getByText(renamed).first()).toBeVisible();
  await expect(page.getByText(original, { exact: true })).toHaveCount(0);

  // Put it back: this suite runs serially against one disposable database and
  // later specs assert on the seeded titles.
  await page.goto(`/admin/sessions/${sessionId}`);
  await titleField.fill(original);
  await page.locator('[data-session-edit-form] button[type="submit"]').click();
  await page.waitForURL(/saved=1/);
  await page.goto(scheduleHref);
  await expect(page.getByText(original).first()).toBeVisible();
});

test("assigning one speaker to two overlapping sessions raises the warning", async ({
  page,
}) => {
  await signInAsAdmin(page);
  const [first, second] = await programmeIds(page);

  const roomsHtml = await (await page.request.get("/admin/agenda/rooms")).text();
  const roomIds = attrValues(roomsHtml, "room-row");
  expect(roomIds.length).toBeGreaterThanOrEqual(2);

  /*
   * Same slot, different rooms: overlapping in time, sharing nobody yet — and
   * deliberately NOT a room clash, so the only blocking conflict this test can
   * create is the speaker one it is about.
   *
   * Worth being explicit about which law is which here, because #152 moved one
   * of them and not the other. Room and speaker double-bookings are blocking on
   * the AGENDA MOVE path: predicted before the write and refused unless forced.
   * Putting a person on two sessions from the SESSION page is not that path —
   * `admin.session.tsx` has no gate — so it still does what this test has always
   * asserted: it warns, on the session and on the Conflicts view.
   */
  const when = await freeSharedTime(page, [roomIds[0], roomIds[1]], DAY);
  await scheduleAt(page, first, roomIds[0], when);
  await scheduleAt(page, second, roomIds[1], when);

  const onSecond = await candidates(page, second);
  const shared = (await candidates(page, first)).find((person) =>
    onSecond.some((other) => other.id === person.id),
  );
  expect(shared, "a person free on both sessions").toBeTruthy();
  // The picker labels the option "Name — email"; the warning names the person.
  const personName = shared!.label.split("—")[0].trim();
  const warning = `Speaker double-booked · ${personName}`;

  /*
   * Asserted on the SPECIFIC warning, not on the presence of any banner: this
   * suite runs serially against one database and earlier specs leave their own
   * placements behind, so "no conflicts at all" is not a property this test can
   * own. What it owns is that THIS person is not double-booked yet.
   */
  await page.goto(`/admin/sessions/${first}`);
  await expect(page.getByText(warning)).toHaveCount(0);

  for (const sessionId of [first, second]) {
    await page.goto(`/admin/sessions/${sessionId}`);
    await page.selectOption('[data-add-participant-form] select[name="personId"]', shared!.id);
    await page.selectOption('[data-add-participant-form] select[name="role"]', "panelist");
    await page.locator('[data-add-participant-form] button[type="submit"]').click();
    await page.waitForURL(/added=/);
  }

  await page.goto(`/admin/sessions/${first}`);
  await expect(page.locator("[data-session-conflict]")).toHaveCount(1);
  await expect(page.getByText(warning).first()).toBeVisible();

  // The agenda shows it too, which is where an organizer would notice.
  const agenda = await (await page.request.get("/admin/agenda?view=conflicts")).text();
  expect(agenda).toContain(`Speaker double-booked · ${personName}`);

  // Leave the programme as we found it.
  for (const sessionId of [first, second]) {
    await page.request.post(`/admin/sessions/${sessionId}`, {
      form: { intent: "remove-participant", personId: shared!.id },
      maxRedirects: 0,
    });
  }
  await page.goto(`/admin/sessions/${first}`);
  await expect(page.getByText(warning)).toHaveCount(0);
});
