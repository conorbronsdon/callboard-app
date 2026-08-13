/**
 * The bulk ZIP resource route (CNT-14).
 *
 * These cases moved here from `admin.files.test.tsx` when the archive moved off
 * `/admin/files`'s action, and they carry a scar with them: every one of them
 * was GREEN while the button on the page returned a 500 HTML error page and no
 * ZIP. Calling `action()` and reading its `Response` cannot see what React
 * Router does to that `Response` on the way to a browser, so the end-to-end
 * claim is made in `tests/e2e/files-download.spec.ts` and nowhere else.
 *
 * What IS provable here, and is the reason this file exists rather than nothing:
 *
 *  1. the module stays a resource route — no `default`, no `ErrorBoundary`.
 *     Adding either one is a one-line change that silently reinstates the 500,
 *     and no other check in the tree would notice;
 *  2. the archive's contents, the event scope, and every refusal path;
 *  3. the bound-parameter count on the WIRE — see the sibling
 *     `admin.files.download.bound-params.test.ts`.
 */
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { uploads } from "~/db/schema";
import { storeUpload } from "~/lib/portal/uploads.server";
import { MAX_ZIP_BYTES } from "~/lib/zip";
import { signedInGet } from "~/test/auth";
import { installTestDb, type TestDbContext } from "~/test/db";
import {
  seedDemoFixture,
  seedOtherEvent,
  type DemoFixture,
  type OtherEventFixture,
} from "~/test/fixtures";
import { env } from "~/test/workers-env";

import * as downloadRoute from "./admin.files.download";

const { action } = downloadRoute;
type ActionArgs = Parameters<typeof action>[0];

const BASE = "https://x.test/admin/files/download";
const asActionArgs = (request: Request) =>
  ({ request, params: {}, context: {} }) as unknown as ActionArgs;

/** In-memory R2: `storeUpload` puts, the ZIP path gets. */
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

async function upload(contents: string, filename = "slides.pdf") {
  const result = await storeUpload({
    file: new File([contents], filename, { type: "text/plain" }),
    eventId: fixture.eventId,
    ownerType: "person",
    ownerId: fixture.speakerIds[0],
    purpose: "document",
    uploadedById: fixture.speakerIds[0],
  });
  if (!result.ok) throw new Error(`upload rejected: ${result.error}`);
  return result.upload;
}

/** POST a selection the way the library's form does: repeated `uploadIds`. */
async function download(personId: string, ids: string[]): Promise<Response> {
  const cookie = (await signedInGet(BASE, personId)).headers.get("cookie") ?? "";
  const body = new URLSearchParams(ids.map((id) => ["uploadIds", id]));
  const request = new Request(BASE, {
    method: "POST",
    headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  return (await action(asActionArgs(request))) as Response;
}

/** The `?download=` code on a refusal redirect. */
function refusalCode(response: Response): string | null {
  const location = response.headers.get("location");
  if (!location) return null;
  return new URL(location, "https://x.test").searchParams.get("download");
}

describe("it is a resource route, and has to stay one", () => {
  /*
   * The whole fix. A UI route's action cannot return a file body to a browser:
   * React Router only takes the resource path when the leaf module has no
   * `default` export (`lib/server-runtime/server.js:117`), otherwise the
   * `Response` is read with `response.text()` and handed back as `actionData`.
   * Exporting a component from this file would restore the 500 with no other
   * test in the tree going red, which is exactly what happened the first time.
   */
  it("MUST FIRE: exports an action and NO component or error boundary", () => {
    const exported = Object.keys(downloadRoute).sort();
    expect(exported).toContain("action");
    expect(exported).not.toContain("default");
    expect(exported).not.toContain("ErrorBoundary");
  });

  it("MUST FIRE: the library's form posts HERE, not to its own action", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const source = readFileSync(
      fileURLToPath(new URL("./admin.files.tsx", import.meta.url)),
      "utf8",
    );
    expect(source).toContain('action={DOWNLOAD}');
    expect(source).toContain('const DOWNLOAD = "/admin/files/download"');
    // MUST NOT FIRE: the intent that used to route it through the page action
    // is gone, so a stale hidden input cannot quietly re-target the old path.
    expect(source).not.toContain('value="bulk-download"');
  });
});

describe("access", () => {
  it("MUST NOT FIRE: a signed-in speaker gets 403, not a redirect or an archive", async () => {
    const file = await upload("deck");
    const thrown = await download(fixture.speakerIds[0], [file.id]).then(
      () => null,
      (error: unknown) => error as Response,
    );
    expect(thrown).toBeInstanceOf(Response);
    expect(thrown?.status).toBe(403);
  });

  it("MUST FIRE: the organizer gets the archive", async () => {
    const file = await upload("deck");
    expect((await download(fixture.adminId, [file.id])).status).toBe(200);
  });
});

describe("the archive", () => {
  it("MUST FIRE: a selection returns a ZIP holding those files' bytes", async () => {
    const one = await upload("first deck contents");
    const two = await upload("run of show", "runsheet.pdf");

    const response = await download(fixture.adminId, [one.id, two.id]);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/zip");
    expect(response.headers.get("content-disposition")).toContain("attachment");
    // The bulk ZIP is a fresh, private, selection-dependent export of live D1
    // rows — armor added during the blindspot audit, pinning cache behavior
    // that was already correct but had never been asserted.
    expect(response.headers.get("cache-control")).toBe("private, no-store");

    const archive = new Uint8Array(await response.arrayBuffer());
    expect(Array.from(archive.slice(0, 4))).toEqual([0x50, 0x4b, 0x03, 0x04]);
    const text = new TextDecoder().decode(archive);
    expect(text).toContain("first deck contents");
    expect(text).toContain("run of show");
    expect(text).toContain("runsheet.pdf");
  });

  it("MUST NOT FIRE: an unticked file's bytes are not in the archive", async () => {
    const ticked = await upload("ticked deck contents");
    await upload("UNTICKED and must not appear", "secret.pdf");

    const text = new TextDecoder().decode(
      new Uint8Array(await (await download(fixture.adminId, [ticked.id])).arrayBuffer()),
    );
    expect(text).toContain("ticked deck contents");
    expect(text).not.toContain("UNTICKED and must not appear");
    expect(text).not.toContain("secret.pdf");
  });
});

describe("refusals redirect back to the library with a code", () => {
  it("MUST NOT FIRE: an empty selection produces a refusal, not an empty archive", async () => {
    const response = await download(fixture.adminId, []);
    expect(response.status).toBe(302);
    expect(refusalCode(response)).toBe("empty");
  });

  it("MUST NOT FIRE: another event's file id is refused rather than zipped", async () => {
    await ctx.db.insert(uploads).values({
      id: "22000000-0000-4000-8000-000000000003",
      eventId: other.eventId,
      ownerType: "person",
      ownerId: other.speakerId,
      purpose: "document",
      key: "other/event/key3.pdf",
      filename: "other-event.pdf",
      contentType: "application/pdf",
      sizeBytes: 10,
      uploadedById: other.speakerId,
    });

    const response = await download(fixture.adminId, [
      "22000000-0000-4000-8000-000000000003",
    ]);
    expect(response.status).toBe(302);
    expect(refusalCode(response)).toBe("foreign");
  });

  it("MUST NOT FIRE: a selection past the size cap is refused before any object is fetched", async () => {
    const file = await upload("deck");
    // Rewrite the declared size past the cap. The guard reads the DB figure, so
    // this proves the refusal happens without allocating the cap in the test.
    await ctx.db
      .update(uploads)
      .set({ sizeBytes: MAX_ZIP_BYTES + 1 })
      .where(eq(uploads.id, file.id));

    const response = await download(fixture.adminId, [file.id]);
    expect(refusalCode(response)).toBe("too-large");
    // The size travels so the page can quote the selection, not just the cap.
    const location = new URL(response.headers.get("location")!, "https://x.test");
    expect(Number(location.searchParams.get("bytes"))).toBe(MAX_ZIP_BYTES + 1);
  });

  it("MUST NOT FIRE: a row whose object is gone is reported, not shipped as an empty ZIP", async () => {
    const file = await upload("deck");
    bucket.objects.delete(file.key);

    expect(refusalCode(await download(fixture.adminId, [file.id]))).toBe("missing");
  });
});
