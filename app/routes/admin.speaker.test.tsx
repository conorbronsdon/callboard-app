/**
 * The speaker profile a submission's speaker names link to: the profile itself,
 * everything they submitted, and both zero states.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { people, uploads } from "~/db/schema";
import { storeUpload } from "~/lib/portal/uploads.server";
import { signedInGet } from "~/test/auth";
import { installTestDb, type TestDbContext } from "~/test/db";
import { seedDemoFixture, type DemoFixture } from "~/test/fixtures";
import { env } from "~/test/workers-env";

import AdminSpeakerDetail, { SpeakerView, loader } from "./admin.speaker";

type LoaderArgs = Parameters<typeof loader>[0];
type LoaderData = Awaited<ReturnType<typeof loader>>;

let ctx: TestDbContext;
let fixture: DemoFixture;

/** In-memory R2 so `storeUpload` has somewhere to put the bytes. */
function createTestBucket() {
  const objects = new Map<string, Uint8Array>();
  return {
    async put(key: string, body: ArrayBuffer) {
      objects.set(key, new Uint8Array(body));
    },
    async get(key: string) {
      const stored = objects.get(key);
      if (!stored) return null;
      return { async arrayBuffer() { return stored.buffer; } };
    },
    async delete(key: string) {
      objects.delete(key);
    },
  };
}

beforeEach(async () => {
  ctx = installTestDb();
  env.FILES = createTestBucket();
  fixture = await seedDemoFixture(ctx.db);
});
afterEach(() => ctx.close());

async function load(id: string): Promise<LoaderData> {
  const request = await signedInGet(`https://x.test/admin/speakers/${id}`, fixture.adminId);
  return loader({ request, params: { id }, context: {} } as unknown as LoaderArgs);
}

/** A deliverable on the speaker's own record — what SPK-10 mirrors. */
async function uploadForSpeaker(
  personId: string,
  contents: string,
  options: { filename?: string; priorUploadId?: string } = {},
) {
  const result = await storeUpload({
    file: new File([contents], options.filename ?? "slides.pdf", { type: "text/plain" }),
    eventId: fixture.eventId,
    ownerType: "person",
    ownerId: personId,
    purpose: "document",
    uploadedById: personId,
    priorUploadId: options.priorUploadId ?? null,
  });
  if (!result.ok) throw new Error(`upload rejected: ${result.error}`);
  return result.upload;
}

describe("loader", () => {
  it("returns the profile and everything that person is on", async () => {
    const data = await load(fixture.speakerIds[0]);

    expect(data.speaker).toMatchObject({
      name: "Sam Speaker",
      email: "speaker@callboard.dev",
      title: "Demo Speaker",
      eventRole: "speaker",
    });
    expect(data.speaker?.links).toEqual([["website", "https://example.com/sam"]]);

    // One abstract as the submitter, plus the program session it composed into.
    const abstracts = data.submissions.filter((row) => row.isAbstract);
    expect(abstracts).toHaveLength(1);
    expect(abstracts[0]).toMatchObject({
      title: "Shipping agents that survive contact with users",
      status: "accepted",
      isPrimary: true,
      trackName: "Agents",
    });
    expect(data.submissions.filter((row) => !row.isAbstract)).toHaveLength(1);
  });

  it("shows a co-speaker's role on someone else's abstract", async () => {
    const data = await load(fixture.speakerIds[6]);
    const abstracts = data.submissions.filter((row) => row.isAbstract);

    expect(abstracts).toHaveLength(2); // their own + the one they co-present
    expect(abstracts.some((row) => row.role === "co_speaker" && !row.isPrimary)).toBe(true);
  });

  it("returns the empty shape for an unknown id", async () => {
    const data = await load("no-such-person");
    expect(data.speaker).toBeNull();
    expect(data.submissions).toEqual([]);
  });
});

describe("render", () => {
  it("renders the profile, links and the submission list", async () => {
    const data = await load(fixture.speakerIds[0]);
    const props = { loaderData: data } as unknown as Parameters<typeof AdminSpeakerDetail>[0];
    const html = renderToStaticMarkup(<AdminSpeakerDetail {...props} />);

    expect(html).toContain("Sam Speaker");
    expect(html).toContain("speaker@callboard.dev");
    expect(html).toContain("https://example.com/sam");
    expect(html).toContain("Submissions (1)");
    expect(html).toContain("Shipping agents that survive contact with users");
    // The abstract title links back into the drill-in.
    expect(html).toContain(`/admin/submissions/${fixture.abstractIds[0]}`);
    // SPK-06: explicit per-speaker portal-invite action.
    expect(html).toContain("speaker-send-invite");
    expect(html).toContain("Send portal invite");
  });

  it("renders a speaker with no bio and no submissions", async () => {
    await ctx.db.insert(people).values({
      id: "00000000-0000-4000-8000-00000000ffff",
      email: "nobody@example.com",
      fullName: "Zero State",
      role: "speaker",
    });
    const data = await load("00000000-0000-4000-8000-00000000ffff");
    const html = renderToStaticMarkup(<SpeakerView {...data} />);

    expect(html).toContain("Zero State");
    expect(html).toContain("No bio yet");
    expect(html).toContain("Nothing submitted yet.");
    expect(html).toContain("Submissions (0)");
  });

  it("renders the not-found state instead of throwing", async () => {
    const html = renderToStaticMarkup(<SpeakerView {...(await load("no-such-person"))} />);
    expect(html).toContain("No such person in this event.");
  });
});

/**
 * SPK-10 — the organizer's per-speaker view of what that speaker has sent us.
 *
 * This block exists because the feature had NO mutation control: deleting the
 * whole `speaker-files` section from `admin.speaker.tsx` left the suite green.
 * Every assertion below was checked against that mutation — with the section
 * removed, the four render cases fail on `speaker-files`, the filename, the
 * version list and the download href respectively.
 */
describe("the speaker's files (SPK-10)", () => {
  it("MUST FIRE: the loader returns the speaker's deliverable as a chain", async () => {
    const file = await uploadForSpeaker(fixture.speakerIds[0], "a deck with bytes");
    const data = await load(fixture.speakerIds[0]);

    expect(data.files).toHaveLength(1);
    expect(data.files[0].filename).toBe("slides.pdf");
    expect(data.files[0].versions).toHaveLength(1);
    expect(data.files[0].latest.id).toBe(file.id);
    expect(data.files[0].latest.href).toBe(`/api/uploads/${file.id}`);
  });

  it("MUST FIRE: the record RENDERS the file list, not just carries the data", async () => {
    const first = await uploadForSpeaker(fixture.speakerIds[0], "version one");
    const second = await uploadForSpeaker(fixture.speakerIds[0], "version two", {
      priorUploadId: first.id,
    });
    const html = renderToStaticMarkup(<SpeakerView {...(await load(fixture.speakerIds[0]))} />);

    // The section itself, its count, and the filename.
    expect(html).toContain("speaker-files");
    expect(html).toContain("Files (2)");
    expect(html).toContain("slides.pdf");

    // Both versions, with exactly one marked Latest — a list that rendered only
    // the newest row would satisfy a bare "contains slides.pdf".
    expect(html).toContain("file-version-list");
    expect(html).toContain('data-version="1"');
    expect(html).toContain('data-version="2"');
    expect(html.match(/data-latest="true"/g) ?? []).toHaveLength(1);

    // Both download links are real and distinct: the superseded version stays
    // retrievable, which is the CNT-04 promise this page inherits.
    expect(html).toContain(`/api/uploads/${first.id}`);
    expect(html).toContain(`/api/uploads/${second.id}`);
  });

  it("MUST NOT FIRE: another speaker's files are not on this speaker's record", async () => {
    await uploadForSpeaker(fixture.speakerIds[0], "mine", { filename: "mine.pdf" });
    await uploadForSpeaker(fixture.speakerIds[1], "theirs", { filename: "theirs.pdf" });

    const html = renderToStaticMarkup(<SpeakerView {...(await load(fixture.speakerIds[0]))} />);
    expect(html).toContain("mine.pdf");
    expect(html).not.toContain("theirs.pdf");
  });

  it("MUST NOT FIRE: a speaker with no uploads gets the zero state, not an empty list", async () => {
    const html = renderToStaticMarkup(<SpeakerView {...(await load(fixture.speakerIds[0]))} />);
    expect(html).toContain("Files (0)");
    expect(html).toContain("Nothing uploaded yet.");
    expect(html).not.toContain("file-version-list");
  });

  /**
   * KNOWN ISSUE, pinned rather than left invisible.
   *
   * The query filters `ownerType = "person"`, but a task upload lands as
   * `ownerType: "session"` whenever the task has a session — the normal case
   * for a slide deck (`portal.task.tsx`, `ownerId: task.sessionId`). So this
   * page shows headshots and profile documents but NOT the session deliverable
   * an organizer is usually chasing, and the PR body's "the same list mirrored"
   * is a strict subset. Widening it needs the speaker's session ids joined in,
   * which is a query change rather than a copy fix, so it is scoped out of this
   * lane. When somebody widens it, THIS test goes red — that is the point of
   * writing the gap down as an assertion instead of a comment.
   */
  it("KNOWN GAP: a session-owned deliverable does not appear on the speaker record", async () => {
    await ctx.db.insert(uploads).values({
      id: "33000000-0000-4000-8000-000000000001",
      eventId: fixture.eventId,
      ownerType: "session",
      ownerId: fixture.programSessionIds[0],
      purpose: "document",
      key: "session/deck.pdf",
      filename: "session-deck.pdf",
      contentType: "application/pdf",
      sizeBytes: 10,
      uploadedById: fixture.speakerIds[0],
    });

    const data = await load(fixture.speakerIds[0]);
    expect(data.files).toHaveLength(0);
    expect(renderToStaticMarkup(<SpeakerView {...data} />)).not.toContain("session-deck.pdf");
  });
});
