/**
 * Public speaker loaders are privacy boundaries, not merely view models.
 * React Router serialises loader returns into SSR documents, so the assertions
 * below inspect `JSON.stringify(payload)` — the wire — rather than rendered JSX.
 *
 * Red-mutation proof: add `email: people.email` to either people projection in
 * `public-speakers.server.ts`, return it from the mapped object, and rerun this
 * file. The `@` and seeded-address assertions must fail.
 */
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { people, uploads } from "~/db/schema";
import { installTestDb, type TestDbContext } from "~/test/db";
import { createTestR2 } from "~/test/r2";
import {
  ADMIN_EMAIL,
  EVENT_ID,
  EVENT_SLUG,
  seedDemoFixture,
  SPEAKERS,
  type DemoFixture,
} from "~/test/fixtures";

import { loader as galleryLoader } from "./embed.gallery";
import { loader as embedSpeakersLoader } from "./embed.speakers";
import { loader as detailLoader } from "./public.speaker";
import { loader as directoryLoader } from "./public.speakers";

let ctx: TestDbContext;
let fixture: DemoFixture;

beforeEach(async () => {
  ctx = installTestDb();
  createTestR2().install();
  fixture = await seedDemoFixture(ctx.db);
});
afterEach(() => ctx.close());

/**
 * Give a person a headshot at a KNOWN key and id, so the assertions below can
 * name the exact strings that must or must not appear on the wire. Searching a
 * payload for "headshotKey" only catches a projection that leaks the column
 * NAME; a hand-rolled `sql` fragment could ship the value under any label.
 */
async function giveHeadshot(personId: string, publishable: boolean) {
  const uploadId = `upload-${personId.slice(-4)}-${publishable ? "yes" : "no"}`;
  const key = `${EVENT_ID}/person/${personId}/headshot/${uploadId}-avatar.png`;
  await ctx.db.insert(uploads).values({
    id: uploadId,
    eventId: EVENT_ID,
    ownerType: "person",
    ownerId: personId,
    purpose: "headshot",
    key,
    filename: "avatar.png",
    contentType: "image/png",
    sizeBytes: 12,
    uploadedById: personId,
  });
  await ctx.db
    .update(people)
    .set({ headshotKey: key, photoPublishable: publishable })
    .where(eq(people.id, personId));
  return { uploadId, key };
}

const directory = (search = "") =>
  directoryLoader({
    request: new Request(`https://x.test/e/${EVENT_SLUG}/speakers${search}`),
    params: { slug: EVENT_SLUG },
    context: {},
  } as unknown as Parameters<typeof directoryLoader>[0]);

const detail = (personId: string) =>
  detailLoader({
    request: new Request(`https://x.test/e/${EVENT_SLUG}/speakers/${personId}`),
    params: { slug: EVENT_SLUG, personId },
    context: {},
  } as unknown as Parameters<typeof detailLoader>[0]);

const embedGallery = () =>
  galleryLoader({
    request: new Request(`https://x.test/embed/${EVENT_SLUG}/gallery`),
    params: { slug: EVENT_SLUG },
    context: {},
  } as unknown as Parameters<typeof galleryLoader>[0]);

const embedDirectory = () =>
  embedSpeakersLoader({
    request: new Request(`https://x.test/embed/${EVENT_SLUG}/speakers`),
    params: { slug: EVENT_SLUG },
    context: {},
  } as unknown as Parameters<typeof embedSpeakersLoader>[0]);

const wire = (payload: unknown) => JSON.stringify(payload);

describe("public speaker payload privacy", () => {
  it("MUST FIRE: list, gallery, and detail payloads contain no email marker or seeded address", async () => {
    const payloads = [await directory(), await directory("?view=gallery"), await detail(fixture.speakerIds[0])];
    const seededEmails = [ADMIN_EMAIL, ...SPEAKERS.map((speaker) => speaker.email)];

    for (const payload of payloads) {
      const serialised = wire(payload);
      expect(serialised).not.toContain("@");
      for (const email of seededEmails) expect(serialised).not.toContain(email);
    }
  });

  it("MUST FIRE: payloads exclude non-qualifying people and non-public person columns", async () => {
    const payloads = [await directory(), await directory("?view=gallery"), await detail(fixture.speakerIds[0])];
    const excludedNames = ["Ada Organiser", ...SPEAKERS.slice(2).map((speaker) => speaker.name)];

    for (const payload of payloads) {
      const serialised = wire(payload);
      for (const name of excludedNames) expect(serialised).not.toContain(name);
      for (const forbidden of [
        "headshotKey",
        "headshot_key",
        "pronouns",
        "links",
        "https://example.com/sam",
        "accept_queue",
        "decline_queue",
      ]) {
        expect(serialised).not.toContain(forbidden);
      }
    }
  });

  it("MUST STILL FIRE: public fields remain on the wire", async () => {
    // Control: a loader returning `{}` would satisfy every absence assertion
    // above. Pinning allowed data proves the privacy projection still has value.
    for (const payload of [await directory(), await directory("?view=gallery")]) {
      const serialised = wire(payload);
      expect(serialised).toContain("Sam Speaker");
      expect(serialised).toContain("Demo Speaker");
      expect(serialised).toContain("Company 0");
    }

    const serialisedDetail = wire(await detail(fixture.speakerIds[0]));
    expect(serialisedDetail).toContain("Sam Speaker");
    expect(serialisedDetail).toContain("Demo Speaker");
    expect(serialisedDetail).toContain("Company 0");
    expect(serialisedDetail).toContain("Sam Speaker works on speaker.");
    expect(serialisedDetail).toContain("Shipping agents that survive contact with users");
  });
});

/**
 * The photo lane's wire boundary.
 *
 * `public.speaker-photo.test.ts` proves the ROUTE refuses an unconsented photo.
 * These prove the LOADERS never hand an anonymous page the material to ask for
 * one in the first place: not the R2 key (which encodes the event id, the
 * person id and the original filename) and not the upload id of a photo that
 * has not been consented to.
 *
 * All four public surfaces are covered, because "the directory is clean" says
 * nothing about the embed widgets that ship the same projection into a third
 * party's page.
 */
describe("public speaker photo payload privacy", () => {
  it("MUST FIRE: no public payload ships an R2 key, consented or not", async () => {
    const consented = await giveHeadshot(fixture.speakerIds[0], true);
    const withheld = await giveHeadshot(fixture.speakerIds[1], false);

    const payloads = [
      await directory(),
      await directory("?view=gallery"),
      await detail(fixture.speakerIds[0]),
      await embedGallery(),
      await embedDirectory(),
    ];

    for (const payload of payloads) {
      const serialised = wire(payload);
      expect(serialised).not.toContain(consented.key);
      expect(serialised).not.toContain(withheld.key);
      // The key's distinctive tail, in case a future projection ships a
      // rewritten or partial form of it.
      expect(serialised).not.toContain("headshot/");
      expect(serialised).not.toContain("avatar.png");
    }
  });

  it("MUST FIRE: an unconsented photo's upload id never reaches a public payload", async () => {
    const withheld = await giveHeadshot(fixture.speakerIds[1], false);

    const payloads = [
      await directory(),
      await directory("?view=gallery"),
      await detail(fixture.speakerIds[1]),
      await embedGallery(),
      await embedDirectory(),
    ];

    for (const payload of payloads) {
      expect(wire(payload)).not.toContain(withheld.uploadId);
    }
  });

  it("MUST STILL FIRE: a consented photo's upload id DOES reach every public payload", async () => {
    // Control. Every absence assertion above is satisfied by a loader that
    // returns no photo data at all, which would silently disable the feature
    // while the privacy suite stayed green.
    const consented = await giveHeadshot(fixture.speakerIds[0], true);

    for (const payload of [
      await directory(),
      await directory("?view=gallery"),
      await embedGallery(),
      await embedDirectory(),
    ]) {
      expect(wire(payload)).toContain(consented.uploadId);
    }
    // The detail page builds the href server-side, so it ships the URL itself.
    expect(wire(await detail(fixture.speakerIds[0]))).toContain(
      `/e/${EVENT_SLUG}/speaker-photo/${fixture.speakerIds[0]}/${consented.uploadId}`,
    );
  });

  it("MUST FIRE: a person with a withheld photo is served the same null as a person with none", async () => {
    await giveHeadshot(fixture.speakerIds[1], false);

    const { speakers } = await directory();
    const withheld = speakers.find((row) => row.id === fixture.speakerIds[1]);
    const never = speakers.find((row) => row.id === fixture.speakerIds[0]);

    // Indistinguishable on the wire: the page cannot reveal that a photo exists
    // but is being withheld, which would be its own small disclosure.
    expect(withheld?.photoVersion).toBeNull();
    expect(never?.photoVersion).toBeNull();
  });
});
