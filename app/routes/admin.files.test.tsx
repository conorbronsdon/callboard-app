/**
 * The Files library, end to end against a real database (CNT-13, SPK-10,
 * CNT-04, CNT-05, CNT-14).
 *
 * The whole point of this route is that an organizer can finally see files a
 * speaker uploaded, so every claim here is asserted from the LOADER's data or
 * from stored rows — never from "the component rendered without throwing".
 *
 * Access is the pair that matters most: `requireAdmin` runs before any query,
 * so the must-not-fire case checks a speaker gets 403 rather than a page with
 * the rows hidden by CSS.
 */
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { uploadComments, uploads } from "~/db/schema";
import { formatBytes } from "~/lib/portal-uploads";
import { storeUpload } from "~/lib/portal/uploads.server";
import { MAX_ZIP_BYTES } from "~/lib/zip";
import { signedInGet, signedInPost } from "~/test/auth";
import { installTestDb, type TestDbContext } from "~/test/db";
import {
  seedDemoFixture,
  seedOtherEvent,
  type DemoFixture,
  type OtherEventFixture,
} from "~/test/fixtures";
import { env } from "~/test/workers-env";

import { FilesScreen, action, loader } from "./admin.files";
import type { FilesData } from "./admin.files";

type LoaderArgs = Parameters<typeof loader>[0];
type ActionArgs = Parameters<typeof action>[0];

const BASE = "https://x.test/admin/files";
const asLoaderArgs = (request: Request) =>
  ({ request, params: {}, context: {} }) as unknown as LoaderArgs;
const asActionArgs = (request: Request) =>
  ({ request, params: {}, context: {} }) as unknown as ActionArgs;

/** In-memory R2: `storeUpload` puts, the ZIP path gets, deletes clean up. */
function createTestBucket() {
  const objects = new Map<string, Uint8Array>();
  return {
    objects,
    binding: {
      async put(key: string, body: ArrayBuffer) {
        objects.set(key, new Uint8Array(body));
      },
      async get(key: string) {
        const stored = objects.get(key);
        if (!stored) return null;
        return {
          async arrayBuffer() {
            return stored.buffer;
          },
        };
      },
      async delete(key: string) {
        objects.delete(key);
      },
    },
  };
}

let ctx: TestDbContext;
let fixture: DemoFixture;
let other: OtherEventFixture;
let bucket: ReturnType<typeof createTestBucket>;

beforeEach(async () => {
  ctx = installTestDb();
  bucket = createTestBucket();
  env.FILES = bucket.binding;
  fixture = await seedDemoFixture(ctx.db);
  other = await seedOtherEvent(ctx.db);
});
afterEach(() => ctx.close());

/** Put a file in the speaker's slot; pass `priorUploadId` to make a version. */
async function upload(
  contents: string,
  options: { filename?: string; priorUploadId?: string; eventId?: string } = {},
) {
  const result = await storeUpload({
    file: new File([contents], options.filename ?? "slides.pdf", { type: "text/plain" }),
    eventId: options.eventId ?? fixture.eventId,
    ownerType: "person",
    ownerId: fixture.speakerIds[0],
    purpose: "document",
    uploadedById: fixture.speakerIds[0],
    priorUploadId: options.priorUploadId ?? null,
  });
  if (!result.ok) throw new Error(`upload rejected: ${result.error}`);
  return result.upload;
}

async function load(personId = fixture.adminId): Promise<FilesData> {
  return loader(asLoaderArgs(await signedInGet(BASE, personId)));
}
async function post(personId: string, fields: Record<string, string>) {
  return action(asActionArgs(await signedInPost(BASE, personId, fields)));
}

describe("access", () => {
  it("MUST NOT FIRE: a signed-in speaker is refused with 403, not shown a masked page", async () => {
    const response = await load(fixture.speakerIds[0]).then(
      () => null,
      (thrown: unknown) => thrown as Response,
    );
    expect(response).toBeInstanceOf(Response);
    expect(response?.status).toBe(403);
  });

  it("MUST FIRE: the organizer gets the library", async () => {
    await upload("deck one");
    const data = await load();
    expect(data.chains).toHaveLength(1);
  });

  it("MUST NOT FIRE: a speaker cannot post a comment through the library either", async () => {
    const file = await upload("deck one");
    const refusal = await post(fixture.speakerIds[0], {
      intent: "comment",
      uploadId: file.id,
      body: "let me in",
    }).then(
      () => null,
      (thrown: unknown) => thrown as Response,
    );
    expect(refusal?.status).toBe(403);
    expect(await ctx.db.select().from(uploadComments)).toHaveLength(0);
  });
});

describe("the library lists what was uploaded, with metadata", () => {
  it("carries uploader, size, content type, timestamp and a download link", async () => {
    const file = await upload("a deck with some bytes in it");
    const [chain] = (await load()).chains;

    expect(chain.filename).toBe("slides.pdf");
    expect(chain.linkageKind).toBe("person");
    expect(chain.linkageLabel).toBe("Sam Speaker");
    expect(chain.latest.uploaderName).toBe("Sam Speaker");
    expect(chain.latest.sizeBytes).toBe(28);
    expect(chain.latest.sizeLabel).toBe("28 B");
    expect(chain.latest.contentType).toBe("text/plain");
    expect(chain.latest.href).toBe(`/api/uploads/${file.id}`);
    expect(chain.latest.createdAt).toBeGreaterThan(0);
  });

  it("MUST NOT FIRE: another event's files are not in this event's library", async () => {
    await upload("this event");
    await ctx.db.insert(uploads).values({
      id: "22000000-0000-4000-8000-000000000001",
      eventId: other.eventId,
      ownerType: "person",
      ownerId: other.speakerId,
      purpose: "document",
      key: "other/event/key.pdf",
      filename: "other-event.pdf",
      contentType: "application/pdf",
      sizeBytes: 10,
      uploadedById: other.speakerId,
    });

    const names = (await load()).chains.map((chain) => chain.filename);
    expect(names).toEqual(["slides.pdf"]);
    expect(names).not.toContain("other-event.pdf");
  });

  it("renders the version and Latest marker into the markup, not just the data", async () => {
    const first = await upload("version one");
    await upload("version two", { priorUploadId: first.id });
    const data = await load();
    const { renderToStaticMarkup } = await import("react-dom/server");
    const html = renderToStaticMarkup(<FilesScreen {...data} />);

    expect(html).toContain("Latest");
    expect(html).toContain("v1");
    expect(html).toContain("v2");
    expect(html).toContain(`/api/uploads/${data.chains[0].latest.id}`);
    // MUST NOT FIRE: the superseded version is still offered, not hidden.
    expect(html).toContain(`/api/uploads/${first.id}`);
  });
});

describe("versioning (CNT-04)", () => {
  it("MUST FIRE: a second upload becomes v2, is marked Latest, and v1 is still retrievable", async () => {
    const first = await upload("version one");
    const second = await upload("version two", { priorUploadId: first.id });

    const [chain] = (await load()).chains;
    expect(chain.versions.map((version) => [version.version, version.id])).toEqual([
      [1, first.id],
      [2, second.id],
    ]);
    expect(chain.latest.id).toBe(second.id);
    expect(chain.versions[0].isLatest).toBe(false);
    expect(chain.versions[1].isLatest).toBe(true);

    // The point of "still retrievable": v1's row AND its R2 object both survive.
    const storedV1 = await ctx.db.query.uploads.findFirst({ where: eq(uploads.id, first.id) });
    expect(storedV1).toBeTruthy();
    expect(bucket.objects.has(storedV1!.key)).toBe(true);
    expect(storedV1!.key).not.toBe(second.key);
  });

  it("links a same-name re-upload into the chain even with no prior id threaded through", async () => {
    const first = await upload("version one");
    const second = await upload("version two");
    const stored = await ctx.db.query.uploads.findFirst({ where: eq(uploads.id, second.id) });
    expect(stored?.versionOf).toBe(first.id);
    expect((await load()).chains).toHaveLength(1);
  });

  it("MUST NOT FIRE: a DIFFERENT file is its own deliverable, not a version", async () => {
    await upload("version one");
    await upload("run of show", { filename: "runsheet.pdf" });
    const chains = await load().then((data) => data.chains);
    expect(chains).toHaveLength(2);
    expect(chains.every((chain) => chain.versions.length === 1)).toBe(true);
  });

  it("MUST NOT FIRE: a prior id from another event cannot graft a chain", async () => {
    const foreign = await storeUpload({
      file: new File(["foreign"], "slides.pdf", { type: "text/plain" }),
      eventId: other.eventId,
      ownerType: "person",
      ownerId: other.speakerId,
      purpose: "document",
      uploadedById: other.speakerId,
    });
    if (!foreign.ok) throw new Error("setup upload failed");

    const mine = await upload("mine", { priorUploadId: foreign.upload.id });
    const stored = await ctx.db.query.uploads.findFirst({ where: eq(uploads.id, mine.id) });
    expect(stored?.versionOf).toBeNull();
  });
});

describe("comments (CNT-05)", () => {
  it("MUST FIRE: an organizer comment is stored with author and timestamp and shows in the library", async () => {
    const file = await upload("deck");
    const before = Date.now();
    const response = (await post(fixture.adminId, {
      intent: "comment",
      uploadId: file.id,
      body: "Please add a slide numbering the demos.",
    })) as Response;
    expect(response.status).toBe(302);

    const [stored] = await ctx.db.select().from(uploadComments);
    expect(stored.body).toBe("Please add a slide numbering the demos.");
    expect(stored.authorId).toBe(fixture.adminId);
    expect(stored.authorName).toBe("Ada Organiser");
    expect(stored.createdAt.getTime()).toBeGreaterThanOrEqual(before - 1000);

    const [chain] = (await load()).chains;
    expect(chain.comments).toHaveLength(1);
    expect(chain.comments[0].authorName).toBe("Ada Organiser");
    expect(chain.comments[0].createdAt).toBeGreaterThan(0);
  });

  it("a comment written on v1 is still on the thread after v2 lands", async () => {
    const first = await upload("version one");
    await post(fixture.adminId, { intent: "comment", uploadId: first.id, body: "First pass." });
    await upload("version two", { priorUploadId: first.id });

    const [chain] = (await load()).chains;
    expect(chain.versions).toHaveLength(2);
    expect(chain.comments.map((comment) => comment.body)).toEqual(["First pass."]);
  });

  it("MUST NOT FIRE: a blank comment writes nothing", async () => {
    const file = await upload("deck");
    expect(await post(fixture.adminId, { intent: "comment", uploadId: file.id, body: "   " })).toMatchObject({
      ok: false,
    });
    expect(await ctx.db.select().from(uploadComments)).toHaveLength(0);
  });

  it("MUST NOT FIRE: an upload from another event is not commentable from this one", async () => {
    await ctx.db.insert(uploads).values({
      id: "22000000-0000-4000-8000-000000000002",
      eventId: other.eventId,
      ownerType: "person",
      ownerId: other.speakerId,
      purpose: "document",
      key: "other/event/key2.pdf",
      filename: "other-event.pdf",
      contentType: "application/pdf",
      sizeBytes: 10,
      uploadedById: other.speakerId,
    });

    expect(
      await post(fixture.adminId, {
        intent: "comment",
        uploadId: "22000000-0000-4000-8000-000000000002",
        body: "should not land",
      }),
    ).toMatchObject({ ok: false });
    expect(await ctx.db.select().from(uploadComments)).toHaveLength(0);
  });
});

/*
 * Bulk download moved to `admin.files.download.test.ts` with the archive
 * itself. What stays here is the library's half of the contract: this action
 * must NOT try to serve a file, and the page must render the refusal the
 * download route redirects back with.
 */
describe("bulk download is not this route's job (CNT-14)", () => {
  it("MUST NOT FIRE: the old bulk-download intent no longer returns bytes", async () => {
    const file = await upload("deck");
    const result = await post(fixture.adminId, {
      intent: "bulk-download",
      uploadIds: file.id,
    });
    // Not a Response at all — a UI route's action cannot deliver one to a
    // browser, which is the entire reason the archive moved.
    expect(result).not.toBeInstanceOf(Response);
    expect(result).toMatchObject({ ok: false, error: "Unknown action." });
  });

  it("MUST FIRE: a refusal code from the download route is rendered as a message", async () => {
    await upload("deck");
    const data = await loader(
      asLoaderArgs(
        await signedInGet(`${BASE}?download=too-large&bytes=${33 * 1024 * 1024}`, fixture.adminId),
      ),
    );
    expect(data.downloadError).toContain("capped at");
    expect(data.downloadError).toContain("33.0 MB");
    // The cap it quotes is MAX_ZIP_BYTES itself, so the sentence cannot outlive
    // a change to the constant.
    expect(data.downloadError).toContain(formatBytes(MAX_ZIP_BYTES));

    const { renderToStaticMarkup } = await import("react-dom/server");
    expect(renderToStaticMarkup(<FilesScreen {...data} />)).toContain("capped at");
  });

  it("MUST NOT FIRE: an unrecognised code is dropped, not echoed onto the page", async () => {
    await upload("deck");
    const data = await loader(
      asLoaderArgs(
        await signedInGet(
          `${BASE}?download=${encodeURIComponent("Call 555-0100 to unlock your files")}`,
          fixture.adminId,
        ),
      ),
    );
    expect(data.downloadError).toBeUndefined();

    const { renderToStaticMarkup } = await import("react-dom/server");
    expect(renderToStaticMarkup(<FilesScreen {...data} />)).not.toContain("555-0100");
  });
});

describe("the 500-row window is reported, not silent", () => {
  it("MUST FIRE: a truncated page says how many files it is not showing", async () => {
    await upload("deck");
    const data = await load();
    // The window is 500; forcing the counts is enough to exercise the copy
    // without seeding 501 rows, and the loader's own counting is asserted
    // below by the untruncated case.
    const truncated = { ...data, totalRows: 812, renderedRows: 500 };

    const { renderToStaticMarkup } = await import("react-dom/server");
    const html = renderToStaticMarkup(<FilesScreen {...truncated} />);
    expect(html).toContain("files-truncated");
    expect(html).toContain("500 newest files of 812");
  });

  it("MUST NOT FIRE: an untruncated page shows no such warning", async () => {
    await upload("deck one");
    await upload("deck two", { filename: "runsheet.pdf" });
    const data = await load();

    // Counted from the table, not guessed from the window size.
    expect(data.totalRows).toBe(2);
    expect(data.renderedRows).toBe(2);

    const { renderToStaticMarkup } = await import("react-dom/server");
    expect(renderToStaticMarkup(<FilesScreen {...data} />)).not.toContain("files-truncated");
  });
});
