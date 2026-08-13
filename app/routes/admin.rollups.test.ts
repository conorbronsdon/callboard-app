/**
 * THE ROLLUP GATE.
 *
 * Both rival entries we reviewed shipped a dashboard whose numbers were
 * silently wrong — counts zeroed or double-counted — while every list page they
 * summarised stayed correct. That failure has a shape: a rollup is the only
 * number on a screen with nothing beside it to disagree with, so a broken
 * aggregate renders as a confident, plausible integer and no test that asserts
 * "the response has a `counts` object" ever notices.
 *
 * So every assertion here is VALUE-PINNED, and pinned against
 * `FIXTURE_ROLLUPS` — expectations DERIVED in `app/test/fixtures.ts` from the
 * same arrays the inserts are built from. A fixture edit moves the data and the
 * expectation together; a query edit moves only the measurement, and that is
 * the case this file exists to fail on.
 *
 * Three independent derivations, on purpose:
 *   1. the fixture constants (what the data is meant to be),
 *   2. raw SQL through `ctx.sqlite` (the same rows, counted by a different
 *      engine path than drizzle's),
 *   3. the loader's own list rows (the rollup must agree with the table it
 *      claims to summarise — the exact invariant the rivals broke).
 *
 * Proved by mutation, not by being green: see PR notes. Breaking the
 * `totalContacts` aggregate into a naive join fan-out turns "the org rollups
 * agree" red, and dropping `having(count >= 2)` from the returning-contacts
 * query turns the returning assertions red.
 */
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { eventPeople, people, sessions } from "~/db/schema";
import { signedInGet } from "~/test/auth";
import { installTestDb, type TestDbContext } from "~/test/db";
import {
  ADMIN_ID,
  FIXTURE_ROLLUPS,
  SPEAKERS,
  seedDemoFixture,
  seededCompany,
  seedOtherEvent,
  type DemoFixture,
} from "~/test/fixtures";

import { loader as contactsLoader, type ContactsData } from "./admin.contacts";
import { loader as dashboardLoader } from "./admin.index";

const asArgs = (request: Request) => ({ request, params: {}, context: {} }) as never;

let ctx: TestDbContext;
let fixture: DemoFixture;

beforeEach(async () => {
  ctx = installTestDb();
  fixture = await seedDemoFixture(ctx.db);
});
afterEach(() => ctx.close());

const dashboard = async () =>
  dashboardLoader(asArgs(await signedInGet("https://x.test/admin", fixture.adminId)));

const contacts = async (query = ""): Promise<ContactsData> =>
  contactsLoader(asArgs(await signedInGet(`https://x.test/admin/contacts${query}`, fixture.adminId)));

/** A second derivation of the same number, straight through node:sqlite. */
const countBySql = (sql: string): number =>
  (ctx.sqlite.prepare(`select count(*) as n from ${sql}`).get() as { n: number }).n;

describe("admin.index — the dashboard tiles, pinned to the fixture", () => {
  it("every tile equals its fixture-derived value", async () => {
    const { counts } = await dashboard();

    expect(counts).toMatchObject({
      abstracts: FIXTURE_ROLLUPS.abstracts,
      accepted: FIXTURE_ROLLUPS.acceptedAbstracts,
      openTasks: FIXTURE_ROLLUPS.openTasks,
      openForms: FIXTURE_ROLLUPS.openCfpForms,
    });
    // No tile may be undefined-rendered or quietly added without a value.
    for (const [label, value] of Object.entries(counts ?? {})) {
      expect(typeof value, `${label} must be a number`).toBe("number");
      expect(Number.isFinite(value), `${label} must be finite`).toBe(true);
    }
  });

  it("the same numbers hold when counted by raw SQL rather than by drizzle", async () => {
    const { counts } = await dashboard();
    const event = fixture.eventId;

    expect(counts?.abstracts).toBe(
      countBySql(`sessions where is_abstract = 1 and event_id = '${event}'`),
    );
    expect(counts?.accepted).toBe(
      countBySql(`sessions where is_abstract = 1 and status = 'accepted' and event_id = '${event}'`),
    );
    expect(counts?.openTasks).toBe(
      countBySql(`tasks where status in ('pending','in_progress') and event_id = '${event}'`),
    );
    expect(counts?.openForms).toBe(
      countBySql(`forms where surface = 'cfp' and status = 'open' and event_id = '${event}'`),
    );
  });

  it("MUST NOT FIRE: the accepted tile is not the naive count of accepted ROWS", async () => {
    const { counts } = await dashboard();
    // The seed composes each accepted abstract into a programme session that
    // carries the same status. A tile counting every `accepted` row shows twice
    // the truth and looks entirely reasonable doing it.
    expect(countBySql("sessions where status = 'accepted'")).toBe(
      FIXTURE_ROLLUPS.acceptedRowsOfAnyKind,
    );
    expect(counts?.accepted).toBe(FIXTURE_ROLLUPS.acceptedAbstracts);
    expect(counts?.accepted).not.toBe(FIXTURE_ROLLUPS.acceptedRowsOfAnyKind);
  });

  it("MUST NOT FIRE: a second event's rows never reach the primary event's tiles", async () => {
    const before = await dashboard();
    await seedOtherEvent(ctx.db);
    const after = await dashboard();

    // The other-event fixture is deliberately sized differently (2 abstracts,
    // 1 task), so a missing event predicate anywhere above moves a tile.
    expect(after.counts).toEqual(before.counts);
    expect(after.event?.slug).toBe("frontier-ai-summit-2026");
  });

  it("the tiles move with the data, in the direction the data moved", async () => {
    const before = await dashboard();

    await ctx.db.insert(sessions).values({
      id: "rollup-probe-abstract",
      eventId: fixture.eventId,
      title: "One more abstract",
      isAbstract: true,
      status: "accepted",
    });
    const after = await dashboard();

    // A frozen or cached rollup passes every static assertion above.
    expect(after.counts?.abstracts).toBe((before.counts?.abstracts ?? 0) + 1);
    expect(after.counts?.accepted).toBe((before.counts?.accepted ?? 0) + 1);
    // ...and only those two: nothing else on the card may drift on an insert
    // that has nothing to do with it.
    expect(after.counts?.openTasks).toBe(before.counts?.openTasks);
    expect(after.counts?.openForms).toBe(before.counts?.openForms);
  });
});

describe("admin.contacts — the org rollups, pinned to the fixture", () => {
  it("every stat card equals its fixture-derived value", async () => {
    const { stats } = await contacts();

    expect(stats.totalContacts).toBe(FIXTURE_ROLLUPS.contacts);
    expect(stats.totalEvents).toBe(FIXTURE_ROLLUPS.events);
    expect(stats.returningContacts).toBe(FIXTURE_ROLLUPS.returningContacts);
    expect(stats.topCompanies).toEqual(
      // Every seeded company is held by exactly one person, so the ordering
      // falls through to the alphabetical tiebreak.
      Array.from({ length: FIXTURE_ROLLUPS.companies }, (_, index) => ({
        company: seededCompany(index),
        count: 1,
      })),
    );
  });

  it("the rollup agrees with the table it summarises", async () => {
    // THE INVARIANT THE RIVAL DASHBOARDS BROKE: the tile said one thing and the
    // list below it said another, and only the list was right.
    const data = await contacts();
    expect(data.stats.totalContacts).toBe(data.contacts.length);
    expect(data.stats.totalContacts).toBe(countBySql("people where merged_into is null"));
    expect(data.contacts.filter((row) => row.company).length).toBe(SPEAKERS.length);
  });

  it("per-contact counts are per-contact, not the table's total", async () => {
    const data = await contacts();
    // A correlated subquery that loses its correlation returns the SAME number
    // on every row — here, 9 memberships on all nine people.
    expect(new Set(data.contacts.map((row) => row.eventsCount))).toEqual(new Set([1]));
    expect(data.contacts.every((row) => row.notesCount === 0)).toBe(true);
    expect(data.contacts.reduce((sum, row) => sum + row.eventsCount, 0)).toBe(
      countBySql("event_people"),
    );
  });

  it("MUST FIRE across two events: memberships fan out and the rollups must not", async () => {
    await seedOtherEvent(ctx.db);
    const data = await contacts();

    /*
     * This is the coverage the single-event fixture cannot give. With one
     * event, people and event_people have the SAME row count, so a
     * `count(*) from people join event_people` fan-out is invisible: both
     * report 9. Here the admin is on both events, so the join reports 11 rows
     * for 10 people, and the naive version is caught.
     */
    const peopleRows = countBySql("people where merged_into is null");
    const membershipRows = countBySql("event_people");
    expect(membershipRows).toBeGreaterThan(peopleRows);

    expect(data.stats.totalContacts).toBe(peopleRows);
    expect(data.stats.totalContacts).not.toBe(membershipRows);
    expect(data.stats.totalContacts).toBe(data.contacts.length);
    expect(data.stats.totalEvents).toBe(2);

    // Exactly one person is on two events: the organiser.
    expect(data.stats.returningContacts).toBe(1);
    expect(data.contacts.find((row) => row.id === ADMIN_ID)?.eventsCount).toBe(2);
    expect(
      data.contacts.filter((row) => row.eventsCount >= 2).length,
    ).toBe(data.stats.returningContacts);
  });

  it("MUST NOT FIRE: a merged-away contact leaves every rollup", async () => {
    const before = await contacts();

    await ctx.db
      .update(people)
      .set({ mergedInto: fixture.speakerIds[0] })
      .where(eq(people.id, fixture.speakerIds[7]));
    const after = await contacts();

    expect(after.stats.totalContacts).toBe(before.stats.totalContacts - 1);
    expect(after.contacts.length).toBe(before.contacts.length - 1);
    expect(after.stats.totalContacts).toBe(after.contacts.length);
    expect(after.stats.topCompanies).toHaveLength(FIXTURE_ROLLUPS.companies - 1);
    expect(after.stats.topCompanies.map((row) => row.company)).not.toContain(
      seededCompany(7),
    );
  });

  it("returning contacts counts PEOPLE on 2+ events, not memberships", async () => {
    const other = await seedOtherEvent(ctx.db);
    // Put a third event's worth of membership on one speaker: two memberships,
    // one person. A query summing memberships instead of grouping people would
    // now report more returning contacts than there are returning contacts.
    await ctx.db.insert(eventPeople).values({
      eventId: other.eventId,
      personId: fixture.speakerIds[0],
      eventRole: "speaker",
    });

    const data = await contacts();
    expect(data.stats.returningContacts).toBe(2);
    expect(data.contacts.filter((row) => row.eventsCount >= 2).map((row) => row.id).sort()).toEqual(
      [ADMIN_ID, fixture.speakerIds[0]].sort(),
    );
  });

  it("the filtered table moves but the org rollups do not", async () => {
    // The stat cards describe the ORGANISATION, not the current filter. A
    // rollup that quietly picks up the filter reads as a broken count to
    // anybody comparing two filtered views.
    const unfiltered = await contacts();
    const filtered = await contacts(`?company=${encodeURIComponent(seededCompany(1))}`);

    expect(filtered.contacts).toHaveLength(1);
    expect(filtered.stats).toEqual(unfiltered.stats);
  });
});
