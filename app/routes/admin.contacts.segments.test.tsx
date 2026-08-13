/**
 * CRM-09 — a filtered contact directory saved as a NAMED, reusable segment.
 *
 * The claim is not "the chip links somewhere". A saved segment is a link
 * written today and clicked in three months, so every assertion here is about
 * the RESULT SET the stored querystring produces, never about the href:
 *
 *  - MUST FIRE: replaying a segment returns the contacts its filters select,
 *    and a different set from the unfiltered directory.
 *  - MUST NOT FIRE (escaping): a name carrying a script tag renders inert.
 *  - MUST NOT FIRE (rot): a segment naming a tag that has since been deleted
 *    degrades to its REMAINING filters — it does not throw, and it does not
 *    silently keep a dead term in the WHERE clause while the control beside it
 *    reads "Any".
 */
import { renderToStaticMarkup } from "react-dom/server";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { contactSegments, contactTags, eventPeople, events, people } from "~/db/schema";
import { signedInGet, signedInPost } from "~/test/auth";
import { installTestDb, type TestDbContext } from "~/test/db";
import { seedDemoFixture, SPEAKERS, type DemoFixture } from "~/test/fixtures";

import {
  ContactsScreen,
  action as contactsAction,
  loader as contactsLoader,
  normalizeSegmentQuery,
  segmentHref,
  type ContactsData,
} from "./admin.contacts";

const BASE = "https://x.test/admin/contacts";
const asLoaderArgs = (request: Request) =>
  ({ request, params: {}, context: {} }) as unknown as Parameters<typeof contactsLoader>[0];
const asActionArgs = (request: Request) =>
  ({ request, params: {}, context: {} }) as unknown as Parameters<typeof contactsAction>[0];

let ctx: TestDbContext;
let fixture: DemoFixture;

beforeEach(async () => {
  ctx = installTestDb();
  fixture = await seedDemoFixture(ctx.db);
});
afterEach(() => ctx.close());

async function load(query = ""): Promise<ContactsData> {
  return contactsLoader(asLoaderArgs(await signedInGet(`${BASE}${query}`, fixture.adminId)));
}

async function post(fields: Record<string, string>) {
  return contactsAction(asActionArgs(await signedInPost(BASE, fixture.adminId, fields)));
}

const emailsIn = (data: ContactsData) => data.contacts.map((contact) => contact.email).sort();

/** Render the screen the way the route does, for the escaping assertions. */
const markup = (data: ContactsData) => renderToStaticMarkup(<ContactsScreen data={data} />);

/** Two speakers carry the tag; only one of them is `Company 1`. */
async function tagTwoSpeakers(tag: string) {
  await ctx.db.insert(contactTags).values([
    { personId: fixture.speakerIds[1], tag },
    { personId: fixture.speakerIds[3], tag },
  ]);
}

describe("saving a filtered view as a segment", () => {
  it("MUST FIRE: replaying the saved segment returns the filtered contacts, not the whole directory", async () => {
    const everyone = await load();
    expect(everyone.contacts).toHaveLength(SPEAKERS.length + 1);
    expect(everyone.segments).toEqual([]);

    // Save the view the organiser is looking at.
    const saved = await post({
      intent: "save-segment",
      name: "Company 1 people",
      querystring: "company=Company 1",
    });
    expect(saved).toMatchObject({ ok: true, intent: "save-segment" });

    // The chip is offered back with the querystring it was saved with...
    const listed = await load();
    expect(listed.segments).toHaveLength(1);
    expect(listed.segments[0]).toMatchObject({
      name: "Company 1 people",
      querystring: "company=Company+1",
    });

    // ...and replaying THAT value selects the contacts, not just the URL.
    const replayed = await load(`?${listed.segments[0].querystring}`);
    expect(emailsIn(replayed)).toEqual([SPEAKERS[1].email]);
    expect(replayed.contacts.length).toBeLessThan(everyone.contacts.length);
    expect(replayed.company).toBe("Company 1");
    expect(replayed.droppedFilters).toEqual([]);
  });

  it("stores every filter the directory reads, and nothing else", async () => {
    await tagTwoSpeakers("vip");
    await post({
      intent: "save-segment",
      name: "Everything",
      // `page` and `intent` are not directory filters and must not survive.
      querystring: "q=example&company=Company 1&title=Engineer&event=multi&notes=without&tag=vip&page=3&intent=merge",
    });

    const [segment] = (await load()).segments;
    const stored = new URLSearchParams(segment.querystring);
    expect([...stored.keys()].sort()).toEqual([
      "company",
      "event",
      "notes",
      "q",
      "tag",
      "title",
    ]);
    // The exact destination, not just its prefix: a chip that dropped the
    // stored query and linked at the bare directory would satisfy a
    // `toContain("/admin/contacts?")` check while filtering nothing.
    expect(segmentHref(segment.querystring)).toBe(`/admin/contacts?${segment.querystring}`);
    expect(segmentHref("")).toBe("/admin/contacts");
    expect(markup(await load())).toContain(
      `href="/admin/contacts?${segment.querystring.replaceAll("&", "&amp;")}"`,
    );
  });

  it("refuses an unfiltered view and an unnamed segment", async () => {
    expect(await post({ intent: "save-segment", name: "Everyone", querystring: "" })).toMatchObject({
      ok: false,
    });
    expect(
      await post({ intent: "save-segment", name: "  ", querystring: "company=Company 1" }),
    ).toMatchObject({ ok: false });
    expect((await load()).segments).toEqual([]);
  });

  it("saving over a name updates that segment instead of adding a second chip", async () => {
    await post({ intent: "save-segment", name: "Leads", querystring: "company=Company 1" });
    await post({ intent: "save-segment", name: "Leads", querystring: "company=Company 2" });

    const { segments } = await load();
    expect(segments).toHaveLength(1);
    expect(segments[0].querystring).toBe("company=Company+2");
    expect(emailsIn(await load(`?${segments[0].querystring}`))).toEqual([SPEAKERS[2].email]);
  });

  it("deletes a segment, and says so when it is already gone", async () => {
    await post({ intent: "save-segment", name: "Leads", querystring: "company=Company 1" });
    const [segment] = (await load()).segments;

    expect(await post({ intent: "delete-segment", segmentId: segment.id })).toMatchObject({
      ok: true,
    });
    expect((await load()).segments).toEqual([]);
    // MUST NOT FIRE: a second delete is a refusal, not a silent success.
    expect(await post({ intent: "delete-segment", segmentId: segment.id })).toMatchObject({
      ok: false,
    });
  });

  it("is admin-only on both the read and the write", async () => {
    const speaker = fixture.speakerIds[0];
    await expect(
      contactsLoader(asLoaderArgs(await signedInGet(BASE, speaker))),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      contactsAction(
        asActionArgs(
          await signedInPost(BASE, speaker, {
            intent: "save-segment",
            name: "Sneaky",
            querystring: "company=Company 1",
          }),
        ),
      ),
    ).rejects.toMatchObject({ status: 403 });
    expect(
      ctx.sqlite.prepare("select count(*) as n from contact_segments").get(),
    ).toMatchObject({ n: 0 });
  });
});

describe("a segment name is data, not markup", () => {
  const HOSTILE = '<script>alert("xss")</script>';

  it("MUST NOT FIRE: a script tag in the name renders inert", async () => {
    await post({ intent: "save-segment", name: HOSTILE, querystring: "company=Company 1" });

    const data = await load();
    // It really is stored raw — the escaping below is the RENDERER's doing, so
    // this assertion cannot pass because the name was silently stripped.
    expect(data.segments[0].name).toBe(HOSTILE);

    const html = markup(data);
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("alert(&quot;xss&quot;)</script>");
    // The delete control's accessible name carries it too, and is escaped there.
    expect(html).toContain("aria-label=\"Delete segment &lt;script&gt;");
  });

  it("MUST FIRE: an ordinary name still reaches the page", async () => {
    await post({ intent: "save-segment", name: "Workshop leads", querystring: "title=Engineer" });
    expect(markup(await load())).toContain("Workshop leads");
  });
});

describe("a segment whose filter value has since been deleted", () => {
  /**
   * `title=Engineer` matches every seeded speaker but the first; `tag=vip`
   * matches two people, one of whom is an Engineer. The three result sets are
   * therefore all different, which is what makes "degraded to the remaining
   * filters" distinguishable from both "kept the dead term" (empty) and
   * "dropped every filter" (the whole directory).
   */
  const SEGMENT = "title=Engineer&tag=vip";

  it("MUST FIRE first: while the tag exists, both terms are applied", async () => {
    await tagTwoSpeakers("vip");
    const data = await load(`?${SEGMENT}`);

    expect(emailsIn(data)).toEqual([SPEAKERS[1].email, SPEAKERS[3].email].sort());
    expect(data.droppedFilters).toEqual([]);
    expect(data.tag).toBe("vip");
  });

  it("MUST NOT FIRE: deleting the tag degrades to the remaining filters instead of erroring", async () => {
    await tagTwoSpeakers("vip");
    const before = await load(`?${SEGMENT}`);
    await ctx.db.delete(contactTags).where(eq(contactTags.tag, "vip"));

    const after = await load(`?${SEGMENT}`);

    // Not an error, and not an empty table.
    expect(after.contacts.length).toBeGreaterThan(before.contacts.length);
    // The SURVIVING filter is still applied: speaker 0 is a "Demo Speaker",
    // not an Engineer, so a run that dropped every filter would include them.
    expect(emailsIn(after)).toEqual(SPEAKERS.slice(1).map((speaker) => speaker.email).sort());
    expect(after.contacts.length).toBeLessThan((await load()).contacts.length);

    // And the page says which term it ignored, rather than showing a control
    // that reads "Any tag" over a result set that was filtered by one.
    expect(after.droppedFilters).toEqual([
      { field: "tag", label: "Tag", value: "vip" },
    ]);
    expect(after.tag).toBe("");
    expect(markup(after)).toContain('Tag &quot;vip&quot; no longer exists');
  });

  it("MUST NOT FIRE: a live value is never dropped, and free text never is", async () => {
    // The complement of the carve-out above: the mechanism must leave real
    // filters alone, or "degrade gracefully" just means "ignore the filters".
    const live = await load("?title=Engineer&q=rina");
    expect(live.droppedFilters).toEqual([]);
    expect(live.title).toBe("Engineer");
    expect(emailsIn(live)).toEqual([SPEAKERS[1].email]);

    // Free text has no vocabulary to fall out of, so it survives even when it
    // matches nobody.
    const nobody = await load("?q=zzz-not-a-person");
    expect(nobody.q).toBe("zzz-not-a-person");
    expect(nobody.droppedFilters).toEqual([]);
    expect(nobody.contacts).toEqual([]);
  });

  it("an event past the switcher's 20-row option list is still a live filter", async () => {
    /*
     * `listEvents()` caps at 20. Treating "absent from that list" as "deleted"
     * would broaden a one-event segment to the whole directory on any
     * organisation with more than twenty events — the opposite of the failure
     * this mechanism exists to prevent.
     */
    const extraIds: string[] = [];
    for (let index = 0; index < 24; index += 1) {
      const id = `bulk-event-${String(index).padStart(2, "0")}`;
      extraIds.push(id);
      const createdAt = new Date(Date.now() + (index + 1) * 60_000);
      await ctx.db.insert(events).values({
        id,
        name: `Bulk Event ${index}`,
        slug: `bulk-event-${index}`,
        createdAt,
        updatedAt: createdAt,
      });
    }
    const beyondTheCap = extraIds[extraIds.length - 1];
    await ctx.db.insert(eventPeople).values({
      eventId: beyondTheCap,
      personId: fixture.speakerIds[2],
      eventRole: "speaker",
    });

    // Precondition: it really is outside the option list the picker renders.
    const data = await load(`?event=${beyondTheCap}`);
    expect(data.events.map((row) => row.id)).not.toContain(beyondTheCap);

    // MUST FIRE: filtered to that event's one member, not broadened.
    expect(data.droppedFilters).toEqual([]);
    expect(data.event).toBe(beyondTheCap);
    expect(emailsIn(data)).toEqual([SPEAKERS[2].email]);
  });

  it("a tag held only by a merged-away contact leaves the vocabulary", async () => {
    await ctx.db.insert(contactTags).values({ personId: fixture.speakerIds[5], tag: "solo" });
    expect((await load()).tags).toContain("solo");

    await ctx.db
      .update(people)
      .set({ mergedInto: fixture.speakerIds[0] })
      .where(eq(people.id, fixture.speakerIds[5]));

    const after = await load();
    // MUST NOT FIRE: the picker no longer offers an option that can only ever
    // return an empty table...
    expect(after.tags).not.toContain("solo");
    // ...and a segment naming it degrades instead of showing zero rows under a
    // control that reads "solo".
    const replayed = await load("?tag=solo");
    expect(replayed.droppedFilters).toEqual([
      { field: "tag", label: "Tag", value: "solo" },
    ]);
    expect(replayed.contacts.length).toBe(after.contacts.length);
  });

  it("an unknown notes value is not mistaken for a filter", async () => {
    // `notes` has a fixed two-value vocabulary. An unknown value applies no SQL
    // condition, so treating the view as filtered would offer to save a segment
    // that returns the entire directory.
    const bogus = await load("?notes=garbage");
    expect(bogus.notes).toBe("");
    expect(bogus.contacts.length).toBe((await load()).contacts.length);
    expect(markup(bogus)).toContain('name="querystring" value=""');

    // MUST FIRE: the two real values still filter and still save.
    const real = await load("?notes=without");
    expect(real.notes).toBe("without");
    expect(markup(real)).toContain('name="querystring" value="notes=without"');
  });

  it("the directory's two non-vocabulary event modes are not mistaken for dead ids", async () => {
    for (const mode of ["none", "multi"]) {
      const data = await load(`?event=${mode}`);
      expect(data.droppedFilters).toEqual([]);
      expect(data.event).toBe(mode);
    }
    // MUST FIRE: an event id that is not a mode and not a real event IS dead.
    const dead = await load("?event=00000000-0000-4000-8000-000000000999");
    expect(dead.droppedFilters).toMatchObject([{ field: "event", label: "Event" }]);
    expect(dead.event).toBe("");
  });

  it("saving from a degraded view does not re-save the dead term", async () => {
    await tagTwoSpeakers("vip");
    await ctx.db.delete(contactTags).where(eq(contactTags.tag, "vip"));

    const degraded = await load(`?${SEGMENT}`);
    const html = markup(degraded);
    // The hidden field the save form posts carries only the live filters.
    expect(html).toContain('name="querystring" value="title=Engineer"');
    expect(html).not.toContain("tag=vip");
  });
});

describe("normalizeSegmentQuery", () => {
  it("keeps directory keys, drops everything else, and tolerates a leading ?", () => {
    expect(normalizeSegmentQuery("?company=Acme&bogus=1")).toBe("company=Acme");
    expect(normalizeSegmentQuery("company=Acme&bogus=1")).toBe("company=Acme");
    expect(normalizeSegmentQuery("company=  &q=  hi  ")).toBe("q=hi");
    expect(normalizeSegmentQuery("")).toBe("");
  });

  it("encodes a value that would otherwise break out of the querystring", () => {
    const stored = normalizeSegmentQuery('company=<img src=x onerror=alert(1)>&tag=a b');
    expect(stored).not.toContain("<");
    expect(new URLSearchParams(stored).get("company")).toBe("<img src=x onerror=alert(1)>");
    expect(new URLSearchParams(stored).get("tag")).toBe("a b");
  });
});

describe("segments are rows, not settings blobs", () => {
  it("survives a fresh loader call because it is persisted", async () => {
    await post({ intent: "save-segment", name: "Persisted", querystring: "company=Company 1" });
    const row = ctx.sqlite
      .prepare("select name, querystring from contact_segments")
      .all() as { name: string; querystring: string }[];
    expect(row).toEqual([{ name: "Persisted", querystring: "company=Company+1" }]);

    await ctx.db.delete(contactSegments);
    expect((await load()).segments).toEqual([]);
  });
});
