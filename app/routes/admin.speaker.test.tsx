/**
 * The speaker profile a submission's speaker names link to: the profile itself,
 * everything they submitted, and both zero states.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { forms, people, tasks, uploads } from "~/db/schema";
import { storeUpload } from "~/lib/portal/uploads.server";
import { signedInGet } from "~/test/auth";
import { installTestDb, type TestDbContext } from "~/test/db";
import { seedDemoFixture, type DemoFixture } from "~/test/fixtures";
import { env } from "~/test/workers-env";

import AdminSpeakerDetail, {
  SpeakerView,
  loader,
  speakerLoaderPayload,
  type SpeakerLoaderData,
} from "./admin.speaker";

type LoaderArgs = Parameters<typeof loader>[0];
type LoaderData = SpeakerLoaderData;

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
  // The not-found branch answers 404 via `data()`; these tests want the
  // payload either way, so unwrap through the route's own helper.
  return speakerLoaderPayload(
    await loader({ request, params: { id }, context: {} } as unknown as LoaderArgs),
  );
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

async function createCustomFieldTask(options: {
  formId?: string;
  taskId?: string;
  response?: Record<string, unknown> | null;
  questions?: Record<string, unknown>[];
} = {}) {
  const formId = options.formId ?? "47000000-0000-4000-8000-000000000001";
  const taskId = options.taskId ?? "47000000-0000-4000-8000-000000000002";
  await ctx.db.insert(forms).values({
    id: formId,
    eventId: fixture.eventId,
    name: "Speaker custom details",
    surface: "portal",
    target: "submission",
    status: "open",
    schema: {
      sectionTitle: "Speaker details",
      questions: options.questions ?? [
        { key: "arrival", label: "Arrival time", type: "text" },
        { key: "dietary", label: "Dietary needs", type: "textarea" },
      ],
    },
    settings: { surface: "portal", type: "submissions", requireLogin: true },
  });
  await ctx.db.insert(tasks).values({
    id: taskId,
    eventId: fixture.eventId,
    personId: fixture.speakerIds[0],
    title: "Complete speaker details",
    kind: "form",
    formId,
    response: options.response ?? null,
  });
  return { formId, taskId };
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
    expect(data.customFields).toEqual([]);
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
    /*
     * SPK-02 must-not-fire. This copy is what a GENUINELY empty profile should
     * say, and the fix for the silent-discard bug must not reach it: filling
     * blank columns from a form the organizer submitted is the change, showing
     * invented affiliation for a person nobody has described is not. If a
     * future "helpful default" starts writing placeholders, this goes red.
     */
    expect(html).toContain("No affiliation on file");
  });

  it("renders the not-found state instead of throwing", async () => {
    const html = renderToStaticMarkup(<SpeakerView {...(await load("no-such-person"))} />);
    expect(html).toContain("No such person in this event.");
  });
});

describe("speaker custom fields", () => {
  it("must NOT fire: a speaker with no form tasks renders the house zero state and no answers list", async () => {
    const data = await load(fixture.speakerIds[0]);
    expect(data.customFields).toEqual([]);

    const html = renderToStaticMarkup(<SpeakerView {...data} />);
    expect(html).toContain('data-testid="speaker-custom-fields"');
    expect(html).toContain("No custom fields for this speaker.");
    expect(html).toContain("Answers appear here when they complete an assigned portal form.");
    expect(html).not.toContain('data-testid="speaker-custom-field-answers"');
  });

  it("must fire: every unanswered schema question renders the distinct marker instead of a blank dd", async () => {
    await createCustomFieldTask();

    const data = await load(fixture.speakerIds[0]);
    expect(data.customFields).toEqual([
      {
        taskId: "47000000-0000-4000-8000-000000000002",
        taskTitle: "Complete speaker details",
        formName: "Speaker custom details",
        status: "pending",
        answers: [
          { key: "arrival", label: "Arrival time", value: null },
          { key: "dietary", label: "Dietary needs", value: null },
        ],
      },
    ]);
    const html = renderToStaticMarkup(<SpeakerView {...data} />);
    expect(html).toContain("Arrival time");
    expect(html).toContain("Dietary needs");
    expect(html.match(/Not answered yet/g) ?? []).toHaveLength(2);
    expect(html).not.toContain("<dd></dd>");
  });

  it("must fire: arrays booleans and file ids render as organizer-readable values", async () => {
    const upload = await uploadForSpeaker(fixture.speakerIds[0], "speaker rider", {
      filename: "sam-rider.pdf",
    });
    await createCustomFieldTask({
      questions: [
        { key: "dietary", label: "Dietary preferences", type: "multiselect" },
        { key: "recording", label: "Recording permission", type: "checkbox" },
        { key: "needs_rehearsal", label: "Needs rehearsal", type: "checkbox" },
        { key: "rider", label: "Technical rider", type: "file" },
        { key: "session_file", label: "Session-owned file", type: "file" },
      ],
      response: {
        dietary: ["Vegan", "Nut-free"],
        recording: true,
        needs_rehearsal: false,
        rider: upload.id,
        session_file: "47000000-0000-4000-8000-000000000099",
      },
    });

    const data = await load(fixture.speakerIds[0]);
    expect(data.customFields[0].answers).toEqual([
      { key: "dietary", label: "Dietary preferences", value: "Vegan, Nut-free" },
      { key: "recording", label: "Recording permission", value: "Yes" },
      { key: "needs_rehearsal", label: "Needs rehearsal", value: "No" },
      { key: "rider", label: "Technical rider", value: "sam-rider.pdf" },
      { key: "session_file", label: "Session-owned file", value: "File uploaded" },
    ]);
    const html = renderToStaticMarkup(<SpeakerView {...data} />);
    for (const value of [
      "Dietary preferences",
      "Vegan, Nut-free",
      "Recording permission",
      "Yes",
      "Needs rehearsal",
      "No",
      "Technical rider",
      "sam-rider.pdf",
      "Session-owned file",
      "File uploaded",
    ]) {
      expect(html).toContain(value);
    }
    expect(html).not.toContain(">dietary<");
    expect(html).not.toContain(">recording<");
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
