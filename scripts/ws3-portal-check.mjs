#!/usr/bin/env node
/**
 * WS3 acceptance harness — drives the RUNNING app over HTTP.
 *
 *   npm run dev                       # in one terminal
 *   node scripts/ws3-portal-check.mjs # in another
 *
 * Covers the lane's done-when:
 *   1. a seeded speaker completes every task start to finish
 *   2. edits SURVIVE A RELOAD (write, then fresh GET, then assert the value)
 *   3. cross-account IDOR: speaker B is refused speaker A's task/upload/profile,
 *      and — the half that is easy to forget — speaker A still reaches their own
 *   4. impersonation round-trips: admin → portal 200 → back → /admin 200
 *   5. the zero state (a speaker with no submissions and no tasks) renders
 *
 * Every assertion compares a VALUE, not a status code alone: a 200 that renders
 * the wrong page is the failure mode a status-only smoke test cannot see.
 *
 * Node script, not Worker code — `process.env` is legitimate here.
 */
const BASE = (process.argv[2] ?? process.env.CALLBOARD_URL ?? "http://localhost:5173").replace(
  /\/$/,
  "",
);

let passed = 0;
let failed = 0;
const failures = [];

function check(name, condition, detail = "") {
  if (condition) {
    passed += 1;
    console.log(`  PASS  ${name}`);
  } else {
    failed += 1;
    failures.push(name);
    console.log(`  FAIL  ${name}${detail ? `\n        ${detail}` : ""}`);
  }
}

function section(title) {
  console.log(`\n${title}`);
  console.log("-".repeat(title.length));
}

/* ------------------------------------------------------------ http client */

/** A cookie jar per identity, so sessions cannot bleed between actors. */
function newJar() {
  return new Map();
}

function storeCookies(jar, response) {
  const raw = response.headers.getSetCookie?.() ?? [];
  for (const entry of raw) {
    const [pair] = entry.split(";");
    const eq = pair.indexOf("=");
    if (eq < 0) continue;
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    if (value === "" || /max-age=0/i.test(entry)) jar.delete(name);
    else jar.set(name, value);
  }
}

function cookieHeader(jar) {
  return [...jar.entries()].map(([name, value]) => `${name}=${value}`).join("; ");
}

async function request(jar, path, options = {}) {
  const headers = new Headers(options.headers ?? {});
  const cookies = cookieHeader(jar);
  if (cookies) headers.set("cookie", cookies);

  const response = await fetch(`${BASE}${path}`, {
    ...options,
    headers,
    redirect: "manual",
  });
  storeCookies(jar, response);
  return response;
}

/** GET, following redirects while carrying the jar. Returns { status, url, body }. */
async function get(jar, path, maxHops = 5) {
  let current = path;
  for (let hop = 0; hop <= maxHops; hop += 1) {
    const response = await request(jar, current);
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) return { status: response.status, url: current, body: "" };
      current = location.startsWith("http") ? new URL(location).pathname : location;
      continue;
    }
    return { status: response.status, url: current, body: await response.text() };
  }
  return { status: 599, url: current, body: "" };
}

async function post(jar, path, form, { follow = true } = {}) {
  const body = form instanceof FormData ? form : new URLSearchParams(form);
  const response = await request(jar, path, { method: "POST", body });
  if (!follow || response.status < 300 || response.status >= 400) {
    return { status: response.status, location: response.headers.get("location"), body: await response.text() };
  }
  const location = response.headers.get("location");
  const followed = await get(jar, location.startsWith("http") ? new URL(location).pathname : location);
  return { status: followed.status, location, body: followed.body };
}

/* ------------------------------------------------------------------ logins */

async function demoLogin(role) {
  const jar = newJar();
  const response = await request(jar, "/demo", {
    method: "POST",
    body: new URLSearchParams({ role }),
  });
  if (response.status >= 400) {
    // Fall back to a GET-driven demo page if /demo posts differently.
    await get(jar, "/demo");
  }
  return jar;
}

/** Log in as any seeded email via the dev magic link printed on /login. */
async function magicLogin(email) {
  const jar = newJar();
  const response = await request(jar, "/login", {
    method: "POST",
    body: new URLSearchParams({ email }),
  });
  const body = await response.text();
  const match = /\/auth\/verify\?token=[A-Za-z0-9._~+/=%-]+/.exec(body);
  if (!match) throw new Error(`no magic link on /login for ${email}`);
  await get(jar, match[0].replace(/&amp;/g, "&"));
  return jar;
}

/* --------------------------------------------------------------- helpers */

const has = (body, text) => body.includes(text);

/**
 * Pull every /portal/tasks/<id> link out of a rendered page.
 *
 * The charset is `[0-9a-zA-Z-]`, not `[0-9a-f-]`: the seed builds deterministic
 * ids from a text bucket (`000000ta-0000-…`), so a hex-only pattern silently
 * matches nothing and every downstream check "passes" by never running.
 */
function taskIds(body) {
  return [...new Set([...body.matchAll(/\/portal\/tasks\/([0-9a-zA-Z-]{8,})/g)].map((m) => m[1]))];
}

/* ------------------------------------------------------------------- main */

async function main() {
  console.log(`WS3 portal acceptance — ${BASE}\n`);

  /* ═══ 1. speaker walks the portal ═══ */
  section("1. Seeded speaker: portal loads with acceptance status front and centre");

  const speaker = await magicLogin("speaker@callboard.dev");
  const home = await get(speaker, "/portal");
  check("GET /portal is 200", home.status === 200, `got ${home.status}`);
  check(
    "home leads with acceptance status",
    has(home.body, "Accepted") && has(home.body, "My submissions"),
    "expected an 'Accepted' pill and the submissions card",
  );
  check(
    "home shows an outstanding-task count",
    /Tasks outstanding/.test(home.body),
    "no 'Tasks outstanding' stat",
  );
  check(
    "home shows a next-action nudge",
    has(home.body, "Next up") && has(home.body, "Do it now"),
    "no next-action card",
  );
  check(
    "the overdue seeded task is the nudge (priority order)",
    has(home.body, "Overdue") && has(home.body, "Read the speaker handbook"),
    "expected the overdue handbook task to win the nudge",
  );

  const tasksPage = await get(speaker, "/portal/tasks");
  check("GET /portal/tasks is 200", tasksPage.status === 200, `got ${tasksPage.status}`);
  check(
    "tasks are split into submission vs personal buckets",
    has(tasksPage.body, "Submission tasks") && has(tasksPage.body, "My tasks"),
  );
  check(
    "due dates render",
    /due [A-Z][a-z]{2} \d+/.test(tasksPage.body),
    "no 'due Mon D' string on the task list",
  );

  /* ═══ 2. complete every task, start to finish ═══ */
  section("2. Speaker completes every task start-to-finish");

  const allTaskIds = taskIds(tasksPage.body);
  check("speaker has seeded tasks to do", allTaskIds.length >= 5, `found ${allTaskIds.length}`);

  let completedManual = 0;
  let completedForm = 0;

  for (const id of allTaskIds) {
    const detail = await get(speaker, `/portal/tasks/${id}`);
    if (detail.status !== 200) {
      check(`task ${id} detail loads`, false, `got ${detail.status}`);
      continue;
    }

    if (has(detail.body, 'value="submit-form"')) {
      // The embedded portal form: fill every question the seed defines.
      const form = new FormData();
      form.set("intent", "submit-form");
      form.set("shirt_size", "L");
      form.set("arrival", "2026-10-05");
      form.set("av_needs", "USB-C adapter and captions.");
      form.set("code_of_conduct", "on");
      const submitted = await post(speaker, `/portal/tasks/${id}`, form);
      check(
        `form task ${id.slice(0, 8)} submits and completes`,
        submitted.status === 200 && has(submitted.body, "task complete"),
        submitted.body.slice(0, 200),
      );
      completedForm += 1;
    } else if (has(detail.body, 'value="complete"')) {
      const done = await post(speaker, `/portal/tasks/${id}`, { intent: "complete" });
      check(
        `manual task ${id.slice(0, 8)} marks complete`,
        done.status === 200 && has(done.body, "marked complete"),
        done.body.slice(0, 200),
      );
      completedManual += 1;
    }
  }

  check("at least one manual task was completed", completedManual >= 1, `${completedManual}`);
  check("the embedded portal form was completed", completedForm >= 1, `${completedForm}`);

  const afterAll = await get(speaker, "/portal/tasks");
  check(
    "task list now reports 100% complete",
    has(afterAll.body, "100%"),
    "progress meter is not at 100%",
  );
  const homeAfter = await get(speaker, "/portal");
  check(
    "home reports zero outstanding tasks",
    /Tasks outstanding[\s\S]{0,200}>0</.test(homeAfter.body),
    "the outstanding-task stat is not 0",
  );
  check(
    "no task is nudged once every task is done",
    // Scoped to the NUDGE card, not the whole page — the tasks card legitimately
    // links completed tasks, so a page-wide check would never pass.
    !/Next up[\s\S]{0,400}?\/portal\/tasks\//.test(homeAfter.body),
    "the next-action card still points at a task",
  );
  check(
    "the nudge falls through to the profile gap, not to nothing",
    has(homeAfter.body, "/portal/profile") && has(homeAfter.body, "Add a headshot"),
    "with tasks done and no headshot, home should nudge the headshot",
  );

  /* ═══ 3. reload persistence ═══ */
  section("3. Edits survive a fresh GET (reload persistence)");

  const stamp = `WS3 check ${Date.now()}`;
  const saved = await post(speaker, "/portal/profile", {
    intent: "details",
    fullName: "Sam Speaker",
    pronouns: "they/them",
    company: "Callboard",
    title: "Demo Speaker",
    bio: `${stamp}\n\nWritten by the acceptance harness with **markdown**.`,
    link_website: "https://example.com/sam",
    link_linkedin: "",
    link_x: "",
    link_github: "",
  });
  check("profile save returns 200", saved.status === 200, `got ${saved.status}`);
  check("profile save confirms", has(saved.body, "Profile saved"), saved.body.slice(0, 200));

  const reloaded = await get(speaker, "/portal/profile");
  check("bio survives a fresh GET", has(reloaded.body, stamp), "the new bio text is absent");
  check("pronouns survive a fresh GET", has(reloaded.body, "they/them"));
  check("link survives a fresh GET", has(reloaded.body, "https://example.com/sam"));
  check(
    "bio markdown renders through the sanitiser",
    has(reloaded.body, "<strong>markdown</strong>"),
    "markdown was not rendered in the preview",
  );

  const tasksReloaded = await get(speaker, "/portal/tasks");
  check(
    "completed tasks stay completed across a reload",
    has(tasksReloaded.body, "100%"),
    "task completion did not persist",
  );

  const formTaskId = allTaskIds.find(async (id) => id);
  const anyDetail = await get(speaker, `/portal/tasks/${allTaskIds[0]}`);
  check(
    "task detail still renders after completion",
    anyDetail.status === 200 && (has(anyDetail.body, "Complete") || has(anyDetail.body, "Reopen")),
    `got ${anyDetail.status}`,
  );
  void formTaskId;

  /* ═══ 4. resources + sanitiser, visible in the UI ═══ */
  section("4. Resource wiki + server-side sanitised HTML embed");

  const resources = await get(speaker, "/portal/resources");
  check("GET /portal/resources is 200", resources.status === 200, `got ${resources.status}`);
  check("resource pages listed", has(resources.body, "Speaker handbook"));

  const avPage = await get(speaker, "/portal/resources/av-and-slides");
  check("GET a resource page is 200", avPage.status === 200, `got ${avPage.status}`);

  // must NOT fire — the legitimate embeds survive
  check(
    "YouTube iframe survives sanitising",
    has(avPage.body, "https://www.youtube.com/embed/dQw4w9WgXcQ"),
    "the YouTube embed was stripped",
  );
  check(
    "Google Maps iframe survives sanitising",
    has(avPage.body, "https://www.google.com/maps/embed"),
    "the Maps embed was stripped",
  );
  check(
    "safe external link survives",
    has(avPage.body, "https://example.com/av-guide"),
    "the AV guide link was stripped",
  );
  check("markdown body renders", has(avPage.body, "16:9"));

  // must fire — the hostile payload is gone
  check(
    "<script> is stripped from the rendered page",
    !has(avPage.body, "alert(&quot;xss&quot;)") && !has(avPage.body, 'alert("xss")'),
    "the script payload reached the page",
  );
  check(
    "onerror= handler is stripped",
    // Assert on a live ATTRIBUTE (`onerror="` / `onerror='`), not the bare word:
    // the removal report legitimately prints "onerror= event handler", and a
    // naive substring check fails on its own evidence.
    !/onerror\s*=\s*["']/.test(avPage.body),
    "a live onerror attribute reached the page",
  );
  check(
    "the sanitiser reports having caught the onerror handler",
    has(avPage.body, "onerror= event handler"),
    "the removal report does not mention onerror",
  );
  check(
    "javascript: href is stripped",
    !/href="javascript:/i.test(avPage.body),
    "a javascript: href reached the page",
  );
  check(
    "the evil iframe is stripped",
    !has(avPage.body, "evil.example/phish"),
    "a non-allowlisted iframe reached the page",
  );
  check(
    "the removal report is shown to the reader",
    has(avPage.body, "Sanitised server-side") && has(avPage.body, "&lt;script&gt; element"),
    "no removal report rendered",
  );

  /* ═══ 5. cross-account IDOR ═══ */
  section("5. Cross-account access (IDOR): B refused, A still allowed");

  const other = await magicLogin("rina@example.com");

  // Speaker A's task ids came from A's own page.
  const victimTask = allTaskIds[0];
  const bReadsAsTask = await request(other, `/portal/tasks/${victimTask}`);
  check(
    "speaker B gets 404 on speaker A's task",
    bReadsAsTask.status === 404,
    `got ${bReadsAsTask.status}`,
  );

  const bWritesAsTask = await request(other, `/portal/tasks/${victimTask}`, {
    method: "POST",
    body: new URLSearchParams({ intent: "complete" }),
  });
  check(
    "speaker B cannot POST to speaker A's task",
    bWritesAsTask.status === 404,
    `got ${bWritesAsTask.status}`,
  );

  // must NOT fire — A still reaches their own task.
  const aReadsOwn = await get(speaker, `/portal/tasks/${victimTask}`);
  check("speaker A still reaches their own task", aReadsOwn.status === 200, `got ${aReadsOwn.status}`);

  // Uploads: give A a file, then have B try to read it.
  const upload = new FormData();
  upload.set(
    "file",
    new Blob([Buffer.from("89504e470d0a1a0a0000000d49484452", "hex")], { type: "image/png" }),
    "headshot.png",
  );
  upload.set("ownerType", "person");
  upload.set("ownerId", "");
  upload.set("purpose", "headshot");
  const uploadRes = await request(speaker, "/api/upload", { method: "POST", body: upload });
  const uploadJson = await uploadRes.json().catch(() => ({}));
  check(
    "POST /api/upload accepts an authed image",
    uploadRes.status === 200 && uploadJson.ok === true,
    JSON.stringify(uploadJson).slice(0, 200),
  );

  const newUploadId = uploadJson?.upload?.id;
  if (newUploadId) {
    const aReadsFile = await request(speaker, `/api/uploads/${newUploadId}`);
    check("owner can read their own upload", aReadsFile.status === 200, `got ${aReadsFile.status}`);

    const bReadsFile = await request(other, `/api/uploads/${newUploadId}`);
    check(
      "speaker B gets 404 on speaker A's upload",
      bReadsFile.status === 404,
      `got ${bReadsFile.status}`,
    );
  }

  // B tries to attach a file to A's person record.
  const crossUpload = new FormData();
  crossUpload.set("file", new Blob([Buffer.from("hello")], { type: "text/plain" }), "note.txt");
  crossUpload.set("ownerType", "person");
  crossUpload.set("ownerId", "00000008-0000-4000-8000-000000000010"); // speaker A's seeded id
  crossUpload.set("purpose", "document");
  const crossRes = await request(other, "/api/upload", { method: "POST", body: crossUpload });
  check(
    "speaker B cannot attach a file to speaker A's record",
    crossRes.status === 403,
    `got ${crossRes.status}`,
  );

  // Profile: B's profile page must show B, never A.
  const bProfile = await get(other, "/portal/profile");
  check("speaker B reaches their OWN profile", bProfile.status === 200, `got ${bProfile.status}`);
  check(
    "speaker B's profile shows B's data, not A's",
    has(bProfile.body, "rina@example.com") && !has(bProfile.body, stamp),
    "speaker A's bio leaked into speaker B's profile",
  );

  // Anonymous access is refused everywhere.
  const anon = newJar();
  const anonPortal = await request(anon, "/portal");
  check(
    "signed-out visitor is redirected off /portal",
    anonPortal.status >= 300 && anonPortal.status < 400,
    `got ${anonPortal.status}`,
  );
  if (newUploadId) {
    const anonFile = await request(anon, `/api/uploads/${newUploadId}`);
    check(
      "signed-out visitor cannot read an upload",
      anonFile.status !== 200,
      `got ${anonFile.status}`,
    );
  }
  const anonUpload = await request(anon, "/api/upload", { method: "POST", body: new FormData() });
  check(
    "signed-out visitor cannot POST /api/upload",
    anonUpload.status !== 200,
    `got ${anonUpload.status}`,
  );

  // Now that tasks are done, the bio is written AND a headshot exists, the
  // nudge should finally have nothing left to point at.
  const homeComplete = await get(speaker, "/portal");
  check(
    "home reaches the all-caught-up state once nothing is outstanding",
    has(homeComplete.body, "all caught up"),
    "home still shows a next action with tasks, bio and headshot all done",
  );
  check(
    "profile completeness reaches 100%",
    has(homeComplete.body, "100%"),
    "the profile meter is not at 100%",
  );

  /* ═══ 6. impersonation round-trip ═══ */
  section("6. Admin impersonation round-trip");

  const admin = await magicLogin("admin@callboard.dev");
  const adminBefore = await get(admin, "/admin");
  check("admin session reaches /admin", adminBefore.status === 200, `got ${adminBefore.status}`);

  const viewAs = await get(admin, "/admin/view-as");
  check("GET /admin/view-as is 200", viewAs.status === 200, `got ${viewAs.status}`);
  check("view-as lists speakers", has(viewAs.body, "View as speaker"));

  /*
   * Pick the DEMO speaker's row specifically. Grabbing the first `personId` on
   * the page silently impersonates whoever sorts first alphabetically, and the
   * identity assertions below would then be checking the wrong person.
   */
  const viewAsRow = viewAs.body
    .split("<tr")
    .find((row) => row.includes("speaker@callboard.dev"));
  const speakerPersonId = /name="personId" value="([^"]+)"/.exec(viewAsRow ?? "")?.[1];
  check(
    "view-as exposes the demo speaker to impersonate",
    Boolean(speakerPersonId),
    "no row for speaker@callboard.dev",
  );

  const started = await post(admin, "/portal/impersonate", { personId: speakerPersonId });
  check("impersonation lands on the portal with 200", started.status === 200, `got ${started.status}`);
  check(
    "the Back to Admin Mode bar is present",
    has(started.body, "Back to Admin Mode") && has(started.body, "Viewing as"),
    "no impersonation banner",
  );

  const portalWhileImpersonating = await get(admin, "/portal/profile");
  check(
    "the portal renders the SPEAKER's data, not the admin's",
    // Positive assertion: the profile being edited is the SPEAKER's, proven by
    // their email and the bio this harness wrote earlier as that speaker.
    // (A negative "admin email absent" check is wrong — the banner legitimately
    // names the admin, and their email is in the layout's loader payload.)
    has(portalWhileImpersonating.body, "speaker@callboard.dev") &&
      has(portalWhileImpersonating.body, stamp),
    "the impersonated portal is not showing the speaker's own profile",
  );
  check(
    "the impersonated portal is NOT the admin's own profile",
    !/<h1[^>]*>Ada Organiser<\/h1>/.test(portalWhileImpersonating.body),
    "the admin's own profile rendered instead of the speaker's",
  );
  check(
    "the banner persists across portal navigation",
    has(portalWhileImpersonating.body, "Back to Admin Mode"),
    "the banner was lost when navigating",
  );

  /*
   * Cookie REPLAY. A speaker cannot mint an impersonation cookie (the 403
   * below), so lift a real one out of the admin's jar and replay it in speaker
   * B's session. The cookie is signed, so this is exactly the "leaked cookie"
   * case: it must be inert because it is bound to the admin who minted it AND
   * requires an admin session to be honoured.
   *
   * Without this, removing the `real.role !== "admin" || claim.adminId !== real.id`
   * guard leaves the whole suite green — verified by mutation M3.
   */
  const stolenCookie = [...admin.entries()].find(([name]) => name === "cb_view_as")?.[1];
  check("an impersonation cookie exists to replay", Boolean(stolenCookie));
  if (stolenCookie) {
    const replay = newJar();
    for (const [name, value] of other.entries()) replay.set(name, value);
    replay.set("cb_view_as", stolenCookie);

    const replayed = await get(replay, "/portal/profile");
    check(
      "a replayed impersonation cookie is ignored in a speaker's session",
      replayed.status === 200 && !has(replayed.body, "Back to Admin Mode"),
      "the stolen cookie was honoured for a non-admin",
    );
    check(
      "the replaying speaker still sees only their OWN profile",
      has(replayed.body, "rina@example.com") && !has(replayed.body, "speaker@callboard.dev"),
      "a replayed cookie exposed another speaker's profile",
    );
  }

  const stopped = await post(admin, "/portal/impersonate/stop", {});
  check("stopping impersonation returns to /admin with 200", stopped.status === 200, `got ${stopped.status}`);

  const adminAfter = await get(admin, "/admin");
  check(
    "the admin session still works after the round-trip",
    adminAfter.status === 200,
    `got ${adminAfter.status}`,
  );
  const portalAfter = await get(admin, "/portal");
  check(
    "the portal no longer shows the impersonation banner",
    !has(portalAfter.body, "Back to Admin Mode"),
    "the impersonation cookie was not cleared",
  );

  // must fire: a speaker cannot start an impersonation.
  const speakerTriesImpersonation = await request(speaker, "/portal/impersonate", {
    method: "POST",
    body: new URLSearchParams({ personId: speakerPersonId }),
  });
  check(
    "a speaker POSTing /portal/impersonate is refused",
    speakerTriesImpersonation.status === 403,
    `got ${speakerTriesImpersonation.status}`,
  );

  /* ═══ 7. zero state ═══ */
  section("7. Zero state — a brand-new speaker with nothing");

  const newcomer = await magicLogin("newcomer@example.com");
  const zeroHome = await get(newcomer, "/portal");
  check("zero-state home is 200", zeroHome.status === 200, `got ${zeroHome.status}`);
  check(
    "zero-state home says there are no submissions",
    has(zeroHome.body, "No submissions yet"),
    "missing the empty submissions state",
  );
  check(
    "zero-state home says there are no tasks",
    has(zeroHome.body, "No tasks assigned"),
    "missing the empty tasks state",
  );
  check(
    "zero-state home still offers a next action (profile gap)",
    has(zeroHome.body, "Next up"),
    "a new speaker is given nothing to do",
  );

  const zeroTasks = await get(newcomer, "/portal/tasks");
  check("zero-state tasks page is 200", zeroTasks.status === 200, `got ${zeroTasks.status}`);
  check("zero-state tasks page has an empty state", has(zeroTasks.body, "No tasks yet"));

  const zeroSubs = await get(newcomer, "/portal/submissions");
  check("zero-state submissions page is 200", zeroSubs.status === 200, `got ${zeroSubs.status}`);
  check("zero-state submissions page has an empty state", has(zeroSubs.body, "No submissions yet"));

  const zeroProfile = await get(newcomer, "/portal/profile");
  check("zero-state profile page is 200", zeroProfile.status === 200, `got ${zeroProfile.status}`);
  check("zero-state profile has no files", has(zeroProfile.body, "No files yet"));

  const zeroResources = await get(newcomer, "/portal/resources");
  check("zero-state speaker can read resources", zeroResources.status === 200);

  /* ═══ 8. admin portal-form builder ═══ */
  section("8. Admin 3-step portal-form builder");

  const formsList = await get(admin, "/admin/portal-forms");
  check("GET /admin/portal-forms is 200", formsList.status === 200, `got ${formsList.status}`);
  check("the seeded portal form is listed", has(formsList.body, "Speaker logistics"));
  check(
    "CFP forms are NOT listed as portal forms",
    !has(formsList.body, "Call for Proposals 2026"),
    "a CFP form leaked into the portal-form list",
  );

  const created = await post(admin, "/admin/portal-forms", { intent: "create" });
  check("creating a form opens the editor", created.status === 200, `got ${created.status}`);
  check("editor shows all three steps",
    has(created.body, "Form Setup") &&
      has(created.body, "Form Questions") &&
      has(created.body, "Settings"),
  );
  check(
    "a fresh form blocks with the inline hint",
    has(created.body, "Complete all required fields on this step to continue"),
    "no incomplete-step hint",
  );

  const newFormId = /\/admin\/portal-forms\/([0-9a-f-]{8,})/.exec(created.location ?? "")?.[1];
  if (newFormId) {
    const setup = await post(admin, `/admin/portal-forms/${newFormId}`, {
      intent: "setup",
      name: "Harness form",
      title: "A form built by the harness",
    });
    check("step 1 saves and advances to step 2", setup.status === 200 && has(setup.body, "Questions"));

    const added = await post(admin, `/admin/portal-forms/${newFormId}?step=questions`, {
      intent: "add-question",
      label: "Dietary needs",
      type: "textarea",
      required: "on",
    });
    check("step 2 adds a question", added.status === 200 && has(added.body, "dietary_needs"));

    const settings = await post(admin, `/admin/portal-forms/${newFormId}?step=settings`, {
      intent: "settings",
      deadline: "2026-11-01",
      requireLogin: "on",
    });
    check("step 3 saves settings", settings.status === 200 && has(settings.body, "Settings saved"));

    const published = await post(admin, `/admin/portal-forms/${newFormId}`, { intent: "publish" });
    check(
      "a complete form publishes",
      published.status === 200 && has(published.body, "Form published"),
      published.body.slice(0, 200),
    );
  }

  /* ═══ 9. mobile viewport sanity ═══ */
  section("9. 375px viewport — no fixed-width layout traps");

  const mobile = await get(speaker, "/portal");
  check(
    "portal declares a responsive viewport",
    has(mobile.body, 'name="viewport"') && has(mobile.body, "width=device-width"),
  );
  check(
    "no fixed pixel widths in the portal markup",
    !/style="[^"]*width:\s*\d{3,}px/.test(mobile.body),
    "a hard-coded wide element would overflow 375px",
  );
  check(
    "wide table scrolls inside its own container",
    has(viewAs.body, "overflow-x-auto"),
    "the admin table would force horizontal page scroll",
  );

  /* ------------------------------------------------------------- summary */
  console.log(`\n${"=".repeat(58)}`);
  console.log(`WS3 acceptance: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log("\nFailed:");
    for (const name of failures) console.log(`  - ${name}`);
  }
  console.log("=".repeat(58));
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error("\nHarness crashed:", error);
  process.exit(2);
});
