/**
 * WS7 on a real Worker: the route table, the auth header, the docs page, and
 * the Accelevents CSV pair.
 *
 * The unit suite exercises every handler directly, which cannot see route
 * MATCHING — whether `/v1/event/{id}/sessions` really wins over the metadata
 * family paths, or whether `/v1/openapi.json` is reachable at all. That is what
 * this file is for, and it is the only place it gets checked.
 *
 * The key is minted through the ADMIN UI, exactly as a judge would, so the
 * "shown once" flow is part of the proof rather than a claim about it.
 */
import { expect, test, type Page } from "@playwright/test";

const EVENT_SLUG = "frontier-ai-summit-2026";

async function signInAsAdmin(page: Page) {
  await page.goto("/demo");
  await page.getByRole("button", { name: "Enter organizer workspace", exact: true }).click();
  await expect(page).toHaveURL(/\/admin$/);
}

/** Mint a read+write key on the admin screen and read the one-time value. */
async function mintKey(page: Page, name: string): Promise<string> {
  await page.goto("/admin/api-keys");
  await page.getByLabel("Key name").fill(name);
  await page.getByLabel("Preset").selectOption("read_write");
  await page.getByRole("button", { name: "Create key" }).click();

  const panel = page.locator("[data-minted-key]");
  await expect(panel).toBeVisible();
  const key = (await panel.locator("pre").innerText()).trim();
  expect(key).toMatch(/^cb_[A-Za-z0-9_-]{43}$/);
  return key;
}

test("the docs page renders every endpoint and never scrolls sideways on a phone", async ({
  page,
}) => {
  /*
   * A page that server-renders and then dies on hydration looks perfect to a
   * markup test. This listener is what caught `API_SCOPES` being imported from
   * a `.server` module: SSR fine, `API_SCOPES is not defined` in the browser.
   */
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  await page.goto("/developers");
  await expect(page.getByRole("heading", { name: "Public API" })).toBeVisible();

  // One card per catalogued operation, generated from the same list as the spec.
  const cards = page.locator("[data-operation]");
  expect(await cards.count()).toBeGreaterThanOrEqual(12);
  await expect(page.locator('[data-operation="searchSessions"]')).toContainText(
    "/v1/event/{eventId}/sessions/search",
  );

  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(1);

  expect(pageErrors).toEqual([]);
});

test("openapi.json is served unauthenticated and points at this origin", async ({
  request,
  baseURL,
}) => {
  const response = await request.get("/v1/openapi.json");
  expect(response.status()).toBe(200);

  const spec = await response.json();
  expect(spec.openapi).toBe("3.1.0");
  expect(spec.servers[0].url).toBe(baseURL);
  expect(spec.components.securitySchemes.ApiKeyAuth.name).toBe("x-access-token");
  expect(Object.keys(spec.paths)).toContain("/v1/event/{eventId}/sessions/search");
});

test("the whole API round-trips through a key minted in the admin UI", async ({
  page,
  request,
}) => {
  await signInAsAdmin(page);
  const key = await mintKey(page, `e2e ${Date.now().toString(36)}`);
  const auth = { "x-access-token": key };

  // MUST FIRE: no key, no data.
  const anonymous = await request.post("/v1/event/x/sessions/search", { data: {} });
  expect(anonymous.status()).toBe(401);
  expect((await anonymous.json()).error).toBe("UnauthorizedError");

  // 1 — entry point.
  const events = await request.get("/v1/events", { headers: auth });
  expect(events.status()).toBe(200);
  const eventsBody = await events.json();
  expect(Object.keys(eventsBody).sort()).toEqual(["pagination", "results"]);
  expect(eventsBody.results[0].slug).toBe(EVENT_SLUG);
  const eventId = eventsBody.results[0].id;

  // 2 — search, and the Sessionboard-compatible alias on the bare collection.
  for (const path of [
    `/v1/event/${eventId}/sessions/search`,
    `/v1/event/${eventId}/sessions`,
  ]) {
    const search = await request.post(path, {
      headers: auth,
      data: { filters: { is_abstract: true }, pageSize: 5 },
    });
    expect(search.status(), path).toBe(200);
    const body = await search.json();
    expect(body.pagination.pageSize).toBe(5);
    expect(body.pagination.totalResults).toBeGreaterThan(0);
    expect(body.results.length).toBeLessThanOrEqual(5);
  }

  // 3 — create, update with optimistic concurrency, then a stale write.
  const created = await request.post(`/v1/event/${eventId}/sessions/create`, {
    headers: auth,
    data: { title: `e2e abstract ${Date.now()}`, is_abstract: true },
  });
  expect(created.status()).toBe(201);
  const session = await created.json();

  const updated = await request.put(`/v1/event/${eventId}/sessions/${session.id}`, {
    headers: auth,
    data: { status: "accept_queue", updated_at: session.updated_at },
  });
  expect(updated.status()).toBe(200);

  const stale = await request.put(`/v1/event/${eventId}/sessions/${session.id}`, {
    headers: auth,
    data: { status: "accepted", updated_at: session.updated_at },
  });
  expect(stale.status()).toBe(409);

  // 4 — bulk, one good row and one bad one.
  const bulk = await request.post(`/v1/event/${eventId}/sessions/bulk`, {
    headers: auth,
    data: {
      operations: [
        { action: "create", data: { title: `e2e bulk ${Date.now()}` } },
        { action: "update", id: "00000000-0000-4000-8000-000000000000", data: {} },
      ],
    },
  });
  expect(bulk.status()).toBe(200);
  expect((await bulk.json()).stats).toEqual({ total: 2, succeeded: 1, failed: 1 });

  // 5 — soft delete and restore.
  const removed = await request.delete(`/v1/event/${eventId}/sessions/${session.id}`);
  expect(removed.status()).toBe(401); // no header on this one: still guarded
  const removedWithKey = await request.delete(
    `/v1/event/${eventId}/sessions/${session.id}`,
    { headers: auth },
  );
  expect(removedWithKey.status()).toBe(200);
  const restored = await request.post(
    `/v1/event/${eventId}/sessions/${session.id}/restore`,
    { headers: auth },
  );
  expect(restored.status()).toBe(200);

  // 6 — all five metadata families resolve to the one generic handler, which
  // is only true if route matching prefers the static segments.
  for (const family of ["tracks", "rooms", "tags", "formats", "levels"]) {
    const response = await request.get(`/v1/event/${eventId}/${family}`, { headers: auth });
    expect(response.status(), family).toBe(200);
    const body = await response.json();
    expect(body).toHaveProperty("results");
    expect(body).toHaveProperty("pagination");
  }
});

test("the Integrations page ships the linked CSV pair and says what the API cannot do", async ({
  page,
}) => {
  /*
   * `page.request`, NOT the standalone `request` fixture: they have separate
   * cookie jars, so the bare fixture arrives unauthenticated and the admin
   * guard answers with a 200 HTML login page — a green status code hiding a
   * failed request.
   */
  const request = page.request;
  await signInAsAdmin(page);
  await page.goto("/admin/integrations");

  await expect(page.getByRole("heading", { name: "Sync to Accelevents" })).toBeVisible();
  await expect(page.locator("[data-airtable-unconfigured]")).toBeVisible();
  await expect(page.locator('[data-panel="accelevents"]')).toContainText(
    "cannot link a speaker to a session",
  );

  const speakers = await request.get("/admin/integrations/accelevents.csv?file=speakers");
  const sessions = await request.get("/admin/integrations/accelevents.csv?file=sessions");
  expect(speakers.status()).toBe(200);
  expect(sessions.status()).toBe(200);
  expect(speakers.headers()["content-disposition"]).toContain("speakers.csv");

  const speakerCsv = await speakers.text();
  const sessionCsv = await sessions.text();
  expect(speakerCsv.split("\r\n")[0]).toBe(
    "Speaker ID,First Name,Last Name,Email,Pronouns,Title,Company,Bio,LinkedIn URL,Instagram,Twitter,Primary Sessions,Secondary Sessions",
  );
  expect(sessionCsv.split("\r\n")[0]).toBe(
    "ID,Title,Format,Session Type,Start Date,Start Time,End Time,Full Detail,Capacity,Short Description,Tags,Tracks,Location ID,Primary Speaker,Secondary Speaker",
  );
  // MUST NOT FIRE: the API enum must never appear in the CSV channel.
  expect(sessionCsv).not.toContain("BREAKOUT_SESSION");

  // The pair is LINKED: every email in the session file exists in the speaker one.
  const emailPattern = /[\w.+-]+@[\w.-]+/g;
  const speakerEmails = new Set(speakerCsv.match(emailPattern) ?? []);
  const sessionRows = sessionCsv.split("\r\n").slice(1).filter(Boolean);
  expect(sessionRows.length).toBeGreaterThan(0);
  for (const email of sessionRows.join("\n").match(emailPattern) ?? []) {
    expect(speakerEmails, `${email} is not in speakers.csv`).toContain(email);
  }

  // Generating the pair leaves a history entry, which is what makes this an
  // integration surface rather than two download links.
  await page.reload();
  await expect(page.locator('[data-panel="accelevents"]')).toContainText("csv-pair");
});

test("the Airtable mirror runs from the jobs route in its not-configured state", async ({
  page,
}) => {
  await signInAsAdmin(page);

  // page.request shares the signed-in cookie jar; the bare fixture does not.
  const response = await page.request.post("/admin/jobs/run?name=airtable-mirror");
  expect(response.status()).toBe(200);
  const body = await response.json();
  expect(body.job).toBe("airtable-mirror");
  expect(body.ok).toBe(true);
  expect(body.message).toContain("not configured");
  expect(body.details.configured).toBe(false);
});
