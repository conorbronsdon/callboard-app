import { type RouteConfig, index, route } from "@react-router/dev/routes";

/**
 * Route groups per AGENTS.md: `public.*` (open + SSR-fast), `auth.*`,
 * `admin.*` (admin role required), `portal.*` (login required).
 *
 * Adding a route? Put the file in `app/routes/` with your group's prefix and
 * append it to YOUR block below — the blocks are separated so parallel lanes
 * touch different lines of this file.
 */
export default [
  /* ── public ─────────────────────────────────── WS1 / WS6 append here ── */
  index("routes/public.home.tsx"),
  route("ready", "routes/public.ready.ts"),
  route("llms.txt", "routes/llms.txt.ts"),
  route("e/:slug", "routes/public.event.tsx"),
  route("e/:slug/schedule", "routes/public.schedule.tsx"),
  route("e/:slug/schedule/:sessionId", "routes/public.session.tsx"),
  route("e/:slug/schedule.ics", "routes/public.calendar.ts"),
  route("e/:slug/speakers", "routes/public.speakers.tsx"),
  route("e/:slug/speakers/:personId", "routes/public.speaker.tsx"),
  // Event-scoped agent map — sibling of the platform llms.txt route above.
  route("e/:slug/llms.txt", "routes/public.llms.ts"),
  /*
   * Consent-gated headshot bytes. NOT nested under `speakers/:personId` — that
   * would make the photo look like a sub-resource of the profile page, and the
   * two have different gates (the profile is derived from published sessions;
   * the photo additionally requires `people.photo_publishable`). The trailing
   * `:version` is the current `uploads.id`, which is what makes the immutable
   * cache header honest.
   */
  route("e/:slug/speaker-photo/:personId/:version", "routes/public.speaker-photo.ts"),

  /* ── iframe embeds ── chrome-less public widget routes (EMB-14/15) ──
   * Thin wrappers over the public loaders above. Kept OUT of the `e/:slug`
   * family on purpose: `isEmbeddablePath` keys the framing exception off the
   * `/embed` path segment, so an embed route living under `/e/` would either
   * miss the exception or widen it over the whole public site.
   */
  route("embed/:slug/schedule", "routes/embed.schedule.tsx"),
  route("embed/:slug/agenda", "routes/embed.agenda.tsx"),
  route("embed/:slug/speakers", "routes/embed.speakers.tsx"),
  route("embed/:slug/gallery", "routes/embed.gallery.tsx"),
  // Public CFP wizard (WS1b). The bare URL is the shareable "Copy Link" target
  // and renders step ① directly; steps ②–⑤ carry the step in the path.
  route("submit/:eventSlug/:formId", "routes/public.submit.tsx"),
  route("submit/:eventSlug/:formId/step/:step", "routes/public.submit.step.tsx"),
  route("submit/:eventSlug/:formId/success", "routes/public.submit.success.tsx"),

  /* ── auth ──────────────────────────────────────────── WS0 owns these ── */
  route("login", "routes/auth.login.tsx"),
  route("auth/verify", "routes/auth.verify.tsx"),
  route("logout", "routes/auth.logout.tsx"),
  route("demo", "routes/auth.demo.tsx"),

  /* ── reviewer ───── assigned-only workspace, outside organizer chrome ── */
  route("review", "routes/review.index.tsx"),
  route("review/impersonate", "routes/review.impersonate.tsx"),
  route("review/impersonate/stop", "routes/review.impersonate.stop.tsx"),

  /* ── admin ────────────────────────── WS1 / WS2 / WS4 / WS6 append here ── */
  route("admin", "routes/admin.layout.tsx", [
    index("routes/admin.index.tsx"),
    route("forms", "routes/admin.forms.tsx"),
    route("forms/:formId/:step", "routes/admin.forms.edit.tsx"),
    route("submissions", "routes/admin.submissions.tsx"),
    // Kanban view of the same submissions, by review stage — reuses the same
    // audited status-transition path as the list's per-row control. See
    // app/routes/admin.submissions.board.tsx.
    route("submissions/board", "routes/admin.submissions.board.tsx"),
    route("reviews", "routes/admin.reviews.tsx"),
    route("resources", "routes/admin.resources.tsx"),
    // Abstract drill-in + the speaker profile its speaker names link to.
    route("submissions/:id", "routes/admin.submission.tsx"),
    route("agenda", "routes/admin.agenda.tsx"),
    route("sessions/:id", "routes/admin.session.tsx"),
    route("embeds", "routes/admin.embeds.tsx"),
    /* WS4 — rooms are the Day board's columns; minimal name+capacity CRUD. */
    route("agenda/rooms", "routes/admin.agenda.rooms.tsx"),
    /* AIA-02 — tracks group sessions and feed CFP eligible-track pickers. */
    route("agenda/tracks", "routes/admin.agenda.tracks.tsx"),
    route("contacts", "routes/admin.contacts.tsx"),
    route("contacts/:id", "routes/admin.contacts.detail.tsx"),
    route("pipeline", "routes/admin.pipeline.tsx"),
    route("speakers", "routes/admin.speakers.tsx"),
    route("tasks", "routes/admin.tasks.tsx"),
    /* Files library — every upload across the event, grouped into versions. */
    route("files", "routes/admin.files.tsx"),
    /*
     * The bulk ZIP is a RESOURCE route (no default export) even though it sits
     * under the admin layout. Nesting is irrelevant to the dispatch: React
     * Router picks the resource path from the LEAF module's exports, and a UI
     * route's action cannot return a `Response` body to a browser at all — see
     * the module header for the mechanism and the browser proof.
     */
    route("files/download", "routes/admin.files.download.ts"),
    route("speakers/:id", "routes/admin.speaker.tsx"),
    route("settings", "routes/admin.settings.tsx"),
    route("jobs", "routes/admin.jobs.tsx"),
    route("jobs/run", "routes/admin.jobs.run.tsx"),

    /* WS5 — email templates + the comm log (per-speaker via ?person=). */
    route("templates", "routes/admin.templates.tsx"),
    route("comms", "routes/admin.comms.tsx"),

    /* WS3 — impersonation launcher + the 3-step portal-form builder. */
    route("view-as", "routes/admin.viewas.tsx"),
    route("portal-forms", "routes/admin.portalforms.tsx"),
    route("portal-forms/:formId", "routes/admin.portalform.tsx"),

    /* WS7 — public API keys + the Accelevents/Airtable Integrations page. */
    route("api-keys", "routes/admin.apikeys.tsx"),
    route("integrations", "routes/admin.integrations.tsx"),
    route("integrations/accelevents.csv", "routes/admin.integrations.csv.ts"),
    route("submissions/scores.csv", "routes/admin.submissions.scores.csv.ts"),

    /* WS12 — the event switcher's cookie writer. Action only; see the module. */
    route("event", "routes/admin.event.tsx"),
    // Event creation sits beside selection: the successful action selects its row.
    route("events/new", "routes/admin.events.new.tsx"),
  ]),

  /* ── portal ───────────────────────────────────────── WS3 appends here ── */
  route("portal", "routes/portal.layout.tsx", [
    index("routes/portal.index.tsx"),
    route("profile", "routes/portal.profile.tsx"),
    route("submissions", "routes/portal.submissions.tsx"),
    route("submissions/:sessionId/edit", "routes/portal.submission.edit.tsx"),
    route("tasks", "routes/portal.tasks.tsx"),
    route("tasks/:taskId", "routes/portal.task.tsx"),
    route("resources", "routes/portal.resources.tsx"),
    route("resources/:slug", "routes/portal.resource.tsx"),
  ]),

  /*
   * Outside the portal layout on purpose: these return bytes or a redirect, and
   * nesting them would render the portal chrome around a JPEG.
   *
   * `api/upload` is the SHARED authed upload endpoint (WS3 owns it, WS1b's
   * wizard posts to it); `api/uploads/:id` serves the bytes back with the same
   * ownership check.
   */
  route("api/upload", "routes/api.upload.ts"),
  route("api/uploads/:uploadId", "routes/api.upload.download.ts"),
  route("portal/headshot/:personId", "routes/portal.headshot.tsx"),
  route("portal/impersonate", "routes/portal.impersonate.tsx"),
  route("portal/impersonate/stop", "routes/portal.impersonate.stop.tsx"),

  /* ── public API (WS7) ────────────────────────────────────────────────────
   * `/v1`, event-scoped, `x-access-token`. Outside every layout: these return
   * JSON, and nesting them would wrap a payload in page chrome.
   *
   * The five metadata families are registered as STATIC paths rather than one
   * `:family` route. Route ranking would almost certainly put `/sessions`
   * ahead of `/:family`, but "almost certainly" is not a property worth
   * betting the API-compat bonus on — and the drift test in
   * app/lib/api/catalogue.test.ts asserts this list still matches
   * METADATA_FAMILIES.
   */
  route("developers", "routes/public.developers.tsx"),
  route("v1/openapi.json", "routes/v1.openapi.ts"),
  route("v1/events", "routes/v1.events.ts"),
  route("v1/event/:eventId/sessions", "routes/v1.sessions.ts"),
  route("v1/event/:eventId/sessions/search", "routes/v1.sessions.search.ts"),
  route("v1/event/:eventId/sessions/create", "routes/v1.sessions.create.ts"),
  route("v1/event/:eventId/sessions/bulk", "routes/v1.sessions.bulk.ts"),
  route("v1/event/:eventId/sessions/:sessionId", "routes/v1.session.ts"),
  route("v1/event/:eventId/sessions/:sessionId/restore", "routes/v1.session.restore.ts"),
  route("v1/event/:eventId/speakers", "routes/v1.speakers.ts"),
  route("v1/event/:eventId/speakers/search", "routes/v1.speakers.search.ts"),
  route("v1/event/:eventId/speakers/:contactId", "routes/v1.speaker.ts"),
  ...["tracks", "rooms", "tags", "formats", "levels"].flatMap((family) => [
    route(`v1/event/:eventId/${family}`, "routes/v1.metadata.ts", {
      id: `v1-metadata-${family}`,
    }),
    route(`v1/event/:eventId/${family}/create`, "routes/v1.metadata.create.ts", {
      id: `v1-metadata-${family}-create`,
    }),
  ]),
  /*
   * The splat ranks below every static `/v1` path in React Router, so it is a
   * JSON 404 floor; known endpoints such as `/v1/events` still resolve first.
   */
  route("v1/*", "routes/v1.catchall.ts"),
] satisfies RouteConfig;
