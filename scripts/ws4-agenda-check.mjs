#!/usr/bin/env node
/**
 * WS4 acceptance harness — drives the RUNNING app over HTTP.
 *
 *   npm run dev -- --port 5194 --strictPort   # in one terminal
 *   node scripts/ws4-agenda-check.mjs http://localhost:5194
 *
 * Covers the agenda lane's done-when:
 *   1. all SIX views render against seed data — List/Day/Week/Track/Room/Conflicts
 *   2. the zero state renders (every session unscheduled, nothing published)
 *   3. JS-off scheduling ROUND-TRIPS: POST moves a session, a fresh GET shows it
 *   4. a deliberate overlap raises the inline chip AND a Conflicts row
 *   5. publish gates the public schedule, both directions
 *   6. rooms CRUD works
 *
 * Every assertion compares a VALUE in the returned HTML, not a status code: a
 * 200 that renders the wrong day is exactly what a status-only smoke misses.
 *
 * Node script, not Worker code — `process.env` is legitimate here.
 */
const BASE = (process.argv[2] ?? process.env.CALLBOARD_URL ?? "http://localhost:5194").replace(
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

function newJar() {
  return new Map();
}

function storeCookies(jar, response) {
  for (const entry of response.headers.getSetCookie?.() ?? []) {
    const [pair] = entry.split(";");
    const eq = pair.indexOf("=");
    if (eq < 0) continue;
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    if (value === "" || /max-age=0/i.test(entry)) jar.delete(name);
    else jar.set(name, value);
  }
}

async function request(jar, path, options = {}) {
  const headers = new Headers(options.headers ?? {});
  const cookies = [...jar.entries()].map(([n, v]) => `${n}=${v}`).join("; ");
  if (cookies) headers.set("cookie", cookies);
  const response = await fetch(`${BASE}${path}`, { ...options, headers, redirect: "manual" });
  storeCookies(jar, response);
  return response;
}

async function get(jar, path, maxHops = 5) {
  let current = path;
  for (let hop = 0; hop <= maxHops; hop += 1) {
    const response = await request(jar, current);
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) return { status: response.status, url: current, body: "" };
      current = location.startsWith("http") ? new URL(location).pathname + new URL(location).search : location;
      continue;
    }
    return { status: response.status, url: current, body: await response.text() };
  }
  return { status: 599, url: current, body: "" };
}

async function post(jar, path, form) {
  const response = await request(jar, path, {
    method: "POST",
    body: new URLSearchParams(form),
  });
  const location = response.headers.get("location");
  const body = response.status >= 300 && response.status < 400 ? "" : await response.text();
  return { status: response.status, location, body };
}

async function adminJar() {
  const jar = newJar();
  await request(jar, "/demo", { method: "POST", body: new URLSearchParams({ role: "admin" }) });
  const probe = await get(jar, "/admin/agenda");
  if (probe.status !== 200 || !probe.body.includes("Agenda")) {
    throw new Error(`demo admin login failed (status ${probe.status}) — is DEMO_MODE on and the DB seeded?`);
  }
  return jar;
}

/* -------------------------------------------------------------- helpers */

/** Pull every `data-<attr>="value"` out of the markup. */
function attrValues(html, attr) {
  return [...html.matchAll(new RegExp(`data-${attr}="([^"]+)"`, "g"))].map((m) => m[1]);
}

function has(html, needle) {
  return html.includes(needle);
}

/* ------------------------------------------------------------------ main */

const jar = await adminJar();

/* 1. the six views ------------------------------------------------------ */

section("1. All six views render against seed data");

const views = {};
for (const view of ["list", "day", "week", "track", "room", "conflicts"]) {
  const result = await get(jar, `/admin/agenda?view=${view}`);
  views[view] = result.body;
  check(`GET /admin/agenda?view=${view} → 200`, result.status === 200, `status ${result.status}`);
  check(
    `  ${view} view marks its own tab active`,
    has(result.body, `data-view-tab="${view}"`),
    "view tab strip missing",
  );
}

check("List names a seeded programme session", has(views.list, "Shipping agents that survive contact with users"));
check("List shows the Unscheduled bucket heading", has(views.list, "Unscheduled"));
check("Day renders every seeded room as a column", ["Main Stage", "Workshop Room 1", "Workshop Room 2"].every((r) => has(views.day, r)));
check("Day renders the half-hour slot rails", has(views.day, ">08:00<") && has(views.day, ">15:00<"));
check("Day server-renders the drag drop-target form", has(views.day, 'id="agenda-drop-form"'));
check("Day server-renders session cards (works pre-hydration)", attrValues(views.day, "session-card").length > 0);
check("Week groups by ISO week", has(views.week, "Week 2026-W41"));
check("Track lanes by track, with a No track bucket", has(views.track, "Agents") && has(views.track, "No track"));
check("Room lanes by room, with a No room bucket", has(views.room, "Main Stage") && has(views.room, "No room"));
check("Conflicts is clean on seed data", has(views.conflicts, "No conflicts."));

/* 2. JS-off scheduling round-trip -------------------------------------- */

section("2. JS-off scheduling round-trips (POST moves it, GET shows it)");

const listBefore = await get(jar, "/admin/agenda?view=list");
const sessionIds = attrValues(listBefore.body, "session-row");
check("found programme sessions to move", sessionIds.length >= 2, `ids: ${sessionIds.join(", ")}`);
const [sessionA, sessionB] = sessionIds;

// Room ids from the rooms screen, cross-checked against the Day board's slot
// ids (`slot|<roomId>|<day>|<time>`) — the board must be built from the same
// rooms the config screen lists.
const roomIds = attrValues((await get(jar, "/admin/agenda/rooms")).body, "room-row");
const slotRoomIds = [
  ...new Set(
    attrValues(views.day, "slot")
      .filter((s) => s.startsWith("slot|"))
      .map((s) => s.split("|")[1]),
  ),
];
check("found room ids on the rooms screen", roomIds.length >= 3, `rooms: ${roomIds.length}`);
check(
  "the SSR Day board is built from those same rooms",
  roomIds.every((id) => slotRoomIds.includes(id)),
  `board rooms: ${slotRoomIds.length}`,
);

const moved = await post(jar, "/admin/agenda", {
  intent: "schedule",
  sessionId: sessionB,
  roomId: roomIds[2] ?? roomIds[1],
  day: "2026-10-09",
  time: "11:30",
  durationMinutes: "45",
  view: "list",
});
check("POST schedule → 302 redirect", moved.status === 302, `status ${moved.status}`);
check("redirect does NOT warn (free slot)", !String(moved.location).includes("warn=conflict"), String(moved.location));

const afterMove = await get(jar, "/admin/agenda?view=list");
check("fresh GET shows the new time on the moved session", has(afterMove.body, "11:30 AM – 12:15 PM"), "no 11:30 AM – 12:15 PM in list");
check("fresh GET shows the new day heading", has(afterMove.body, "Fri, Oct 9, 2026"));

const dayNine = await get(jar, "/admin/agenda?view=day&day=2026-10-09");
check("the Day board for Oct 9 now holds the card", has(dayNine.body, `data-session-card="${sessionB}"`));

/* 3. a deliberate overlap → chip + Conflicts row ------------------------ */

section("3. A deliberate overlap raises the chip AND a Conflicts row");

const clash = await post(jar, "/admin/agenda", {
  intent: "schedule",
  sessionId: sessionB,
  roomId: roomIds[0],
  day: "2026-10-07",
  time: "15:00", // exactly where session A already sits
  durationMinutes: "30",
  view: "list",
});
check("POST into a conflict still SAVES (302, not blocked)", clash.status === 302, `status ${clash.status}`);
check("redirect carries warn=conflict", String(clash.location).includes("warn=conflict"), String(clash.location));

const warnPath = clash.location
  ? String(clash.location).replace(BASE, "")
  : "/admin/agenda?view=list&warn=conflict";
const warned = await get(jar, warnPath);
check("the warning banner renders", has(warned.body, 'data-conflict-warning="1"'));

const listClash = await get(jar, "/admin/agenda?view=list");
const chips = attrValues(listClash.body, "conflict-chip");
check("inline chip on BOTH conflicting cards", chips.includes(sessionA) && chips.includes(sessionB), `chips: ${chips.join(", ")}`);

const conflictsClash = await get(jar, "/admin/agenda?view=conflicts");
const rows = attrValues(conflictsClash.body, "conflict-row");
check("a row on the dedicated Conflicts screen", rows.length >= 1, `rows: ${rows.join(", ")}`);
check("the Conflicts row links to BOTH sessions", has(conflictsClash.body, `#session-${sessionA}`) && has(conflictsClash.body, `#session-${sessionB}`));
check("the Conflicts tab carries a count badge", has(conflictsClash.body, 'data-view-tab="conflicts"'));
check("the chip appears in the Day view too", has((await get(jar, "/admin/agenda?view=day&day=2026-10-07")).body, "⚠ Conflict"));

/* 4. publish gates the public schedule ---------------------------------- */

section("4. Publish gates the public schedule");

const slugMatch = /\/e\/([a-z0-9-]+)\/schedule/.exec(listClash.body);
const slug = slugMatch ? slugMatch[1] : "frontier-ai-summit-2026";

await post(jar, "/admin/agenda", { intent: "set-published", sessionId: sessionA, published: "0", view: "list" });
await post(jar, "/admin/agenda", { intent: "set-published", sessionId: sessionB, published: "0", view: "list" });
const publicEmpty = await get(newJar(), `/e/${slug}/schedule`);
check("MUST NOT FIRE: unpublished sessions are invisible publicly", has(publicEmpty.body, "The schedule is not published yet."));
check("  …and no session rows leak", attrValues(publicEmpty.body, "public-session").length === 0);

const publishAll = await post(jar, "/admin/agenda", { intent: "publish-all", view: "list" });
check("publish-all → 302 reporting a count", publishAll.status === 302 && /published=\d+/.test(String(publishAll.location)), String(publishAll.location));

const publicFull = await get(newJar(), `/e/${slug}/schedule`);
check("MUST FIRE: published sessions appear on the public schedule", attrValues(publicFull.body, "public-session").length >= 2);
check("  …grouped under a day heading", has(publicFull.body, "Wed, Oct 7, 2026"));
check("  …anonymously (no login required)", publicFull.status === 200);

/* 5. unschedule → back to the tray, and off the public page ------------- */

section("5. Unschedule returns a session to the tray and unpublishes it");

const cleared = await post(jar, "/admin/agenda", { intent: "unschedule", sessionId: sessionB, view: "list" });
check("POST unschedule → 302", cleared.status === 302, `status ${cleared.status}`);

const afterClear = await get(jar, "/admin/agenda?view=list");
check("the session is back in the Unscheduled bucket", has(afterClear.body, "Unscheduled"));
check("conflicts clear once the overlap is removed", has((await get(jar, "/admin/agenda?view=conflicts")).body, "No conflicts."));
const publicAfterClear = await get(newJar(), `/e/${slug}/schedule`);
check("an unscheduled session drops off the public schedule", !has(publicAfterClear.body, `data-public-session="${sessionB}"`));

/* 6. zero state ---------------------------------------------------------- */

section("6. Zero state — nothing scheduled at all");

for (const id of sessionIds) {
  await post(jar, "/admin/agenda", { intent: "unschedule", sessionId: id, view: "list" });
}
const zeroList = await get(jar, "/admin/agenda?view=list");
check("List still 200s with nothing scheduled", zeroList.status === 200);
check("  …and says nothing is scheduled", has(zeroList.body, "Nothing scheduled yet"));
const zeroDay = await get(jar, "/admin/agenda?view=day");
check("Day board still renders its room columns", has(zeroDay.body, "Main Stage"));
check("  …with everything sitting in the unscheduled tray", has(zeroDay.body, "Unscheduled"));
const zeroConflicts = await get(jar, "/admin/agenda?view=conflicts");
check("Conflicts shows the clean empty state", has(zeroConflicts.body, "No conflicts."));
const zeroPublic = await get(newJar(), `/e/${slug}/schedule`);
check("public schedule shows its own empty state", has(zeroPublic.body, "The schedule is not published yet."));

/* 7. rooms CRUD ---------------------------------------------------------- */

section("7. Rooms config");

const roomsPage = await get(jar, "/admin/agenda/rooms");
check("GET /admin/agenda/rooms → 200", roomsPage.status === 200, `status ${roomsPage.status}`);
check("lists the seeded rooms", has(roomsPage.body, "Main Stage"));

const uniqueName = `Expo Theatre ${Date.now()}`;
const created = await post(jar, "/admin/agenda/rooms", {
  intent: "create",
  name: uniqueName,
  capacity: "250",
});
check("POST create room → 302", created.status === 302, `status ${created.status}`);
const roomsAfter = await get(jar, "/admin/agenda/rooms");
check("the new room is listed", has(roomsAfter.body, uniqueName));
check("the new room becomes a Day board column", has((await get(jar, "/admin/agenda?view=day")).body, uniqueName));

const roomIdsAfter = attrValues(roomsAfter.body, "room-row");
const newRoomId = roomIdsAfter.at(-1);
const deleted = await post(jar, "/admin/agenda/rooms", { intent: "delete", roomId: newRoomId });
check("POST delete room → 302", deleted.status === 302, `status ${deleted.status}`);
check("the room is gone", !has((await get(jar, "/admin/agenda/rooms")).body, uniqueName));

/* ----------------------------------------------------------------- report */

console.log(`\n${"=".repeat(52)}`);
console.log(`WS4 agenda check: ${passed} passed, ${failed} failed`);
if (failed) {
  console.log(`failures:\n  - ${failures.join("\n  - ")}`);
  process.exit(1);
}
console.log("Re-seed with `npm run seed` — this harness mutates the local DB.");
