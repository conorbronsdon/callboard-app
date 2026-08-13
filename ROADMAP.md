# Roadmap

What Callboard builds next, in order, and why. The past record of product
judgment is [DECISIONS.md](DECISIONS.md); this file is the forward half.
The README's [Limitations](README.md#limitations) section points here rather
than restating it — this file is the single source for what is missing on
purpose. (There is no separate landing-page "not built yet" list today — the
public home page at `/` is an events listing, not a truth-card surface; if one
ships later, point it here too rather than duplicating this list.)

A feature appears here only when we can say what it is, why it is sequenced
where it is, and what would have to be true before it ships. Items ship with
the same bar as everything else: red-then-green tests, must-fire and
must-not-fire pairs, and honest docs.

## In progress on main

- **Subsessions.** Parent/child sessions (lightning talks inside a block),
  nested on the agenda and public schedule, `expand=subsession_details` on
  the API for Sessionboard compatibility. Conflict law extends deliberately:
  parent↔child overlap is expected, sibling overlap is advisory, child vs
  unrelated session keeps the blocking rules.
- **Import wizard.** CSV with column mapping plus Sessionize-export import —
  the migration off-ramp a "kill my SaaS" product owes its users. All-or-
  nothing preview before commit, duplicate detection, conflict-held schedule
  imports.

## Next

1. **Per-organization tenancy, then self-serve organizations.** The schema
   reserved the hooks (`org_id` on the field registry) from week one, and the
   sequencing is deliberate: tenancy touches authorization on every query,
   and a wrong tenancy boundary is a security bug, not a missing feature.
   It ships as row-scoped organizer rights first, self-serve org signup
   second, and the one-click judge demo stays — a login wall in front of a
   demo is a cost other tools accept that we will not.
2. **Realtime multi-viewer presence.** Two organizers on the same agenda
   should see each other's moves land live (Durable Object per event). The
   agenda already predicts conflicts before a write, so the collaborative
   layer inherits the same gate law instead of inventing its own.
3. **Awards mode.** The review engine — weighted rubrics, per-round blinding,
   recusal, multi-round assignment — is judging infrastructure. Awards adds
   the vocabulary on top: nomination forms, judging rounds, a winners list.
   No new engine, one new surface.
4. **Airtable as a source of truth.** Today rows mirror out one way. Reading
   edits back needs field allowlists and conflict handling; deferred rather
   than shipped half-done (a silent overwrite of an organizer's work is the
   failure mode we refuse).
5. **Per-key API rate limiting.** `/v1` and `/mcp` currently rely on scoped
   keys without request-rate enforcement — stated plainly in the API docs.
   A per-key limiter on the existing key table closes it without new
   infrastructure.

## Held on purpose

- **Payments, multi-language, marketing CMS** — the buyer's own stated cuts
  (DECISIONS #6); out of scope until a real deployment asks.
- **Real mail on the judged demo** — the demo prints mail to the console so
  every send button is safe to press. Production deployments configure a
  mail key and this constraint disappears.
