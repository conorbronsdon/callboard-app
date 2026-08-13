/**
 * The speaker's half of the file lane (CNT-04, CNT-05, CNT-06).
 *
 * The rubric's claim is that a comment is "visible across roles", so the tests
 * that matter here cross the boundary: a comment written through the ORGANIZER's
 * route is read back through the SPEAKER's loader and vice versa. Asserting one
 * side twice would pass on two disconnected threads.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { forms, tasks, uploadComments, uploads } from "~/db/schema";
import { MAX_UPLOAD_BYTES } from "~/lib/portal-uploads";
import { signedInGet, signedInPost } from "~/test/auth";
import { installTestDb, type TestDbContext } from "~/test/db";
import { seedDemoFixture, type DemoFixture } from "~/test/fixtures";
import { env } from "~/test/workers-env";

import { createLoginSession } from "~/lib/auth/auth.server";

import { action as adminAction, loader as adminLoader } from "./admin.files";
import { action as impersonateAction } from "./portal.impersonate";
import { QuestionField, action, loader } from "./portal.task";

type LoaderArgs = Parameters<typeof loader>[0];
type ActionArgs = Parameters<typeof action>[0];

const TASK_ID = "31000000-0000-4000-8000-000000000001";
const FORM_ID = "32000000-0000-4000-8000-000000000001";
const OTHER_TASK_ID = "31000000-0000-4000-8000-000000000002";
const TASK_URL = `https://x.test/portal/tasks/${TASK_ID}`;
const ADMIN_URL = "https://x.test/admin/files";

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
        return stored ? { async arrayBuffer() { return stored.buffer; } } : null;
      },
      async delete(key: string) {
        objects.delete(key);
      },
    },
  };
}

let ctx: TestDbContext;
let fixture: DemoFixture;
let bucket: ReturnType<typeof createTestBucket>;

beforeEach(async () => {
  ctx = installTestDb();
  bucket = createTestBucket();
  env.FILES = bucket.binding;
  fixture = await seedDemoFixture(ctx.db);

  // A file-request task, exactly as `/admin/tasks` generates one: a portal form
  // whose single question has type "file".
  await ctx.db.insert(forms).values({
    id: FORM_ID,
    eventId: fixture.eventId,
    surface: "portal",
    status: "open",
    target: "session",
    name: "Upload your slides",
    schema: {
      sectionTitle: "Upload your slides",
      questions: [
        { key: "deliverable", label: "Upload your file", type: "file", required: true, filePurpose: "document" },
      ],
    },
    settings: { surface: "portal", type: "submissions", requireLogin: true },
  });
  await ctx.db.insert(tasks).values([
    {
      id: TASK_ID,
      eventId: fixture.eventId,
      personId: fixture.speakerIds[0],
      formId: FORM_ID,
      title: "Send us your deck",
      status: "pending",
    },
    {
      id: OTHER_TASK_ID,
      eventId: fixture.eventId,
      personId: fixture.speakerIds[1],
      formId: FORM_ID,
      title: "Send us your deck",
      status: "pending",
    },
  ]);
});
afterEach(() => ctx.close());

async function loadTask(personId = fixture.speakerIds[0], taskId = TASK_ID) {
  const request = await signedInGet(`https://x.test/portal/tasks/${taskId}`, personId);
  return loader({ request, params: { taskId }, context: {} } as unknown as LoaderArgs);
}

/** Submit the task form with a file attached — the real multipart path. */
async function submitFile(contents: string, personId = fixture.speakerIds[0], taskId = TASK_ID) {
  const url = `https://x.test/portal/tasks/${taskId}`;
  const cookie = (await signedInGet(url, personId)).headers.get("cookie") ?? "";
  const body = new FormData();
  body.append("intent", "submit-form");
  body.append("deliverable", new File([contents], "slides.pdf", { type: "text/plain" }));

  return action({
    request: new Request(url, { method: "POST", headers: { cookie }, body }),
    params: { taskId },
    context: {},
  } as unknown as ActionArgs);
}

async function postToTask(fields: Record<string, string>, personId = fixture.speakerIds[0]) {
  const request = await signedInPost(TASK_URL, personId, fields);
  return action({ request, params: { taskId: TASK_ID }, context: {} } as unknown as ActionArgs);
}

async function adminLibrary() {
  const request = await signedInGet(ADMIN_URL, fixture.adminId);
  return adminLoader({ request, params: {}, context: {} } as unknown as Parameters<
    typeof adminLoader
  >[0]);
}

describe("re-uploading a deliverable (CNT-04)", () => {
  it("MUST FIRE: the second upload is v2, marked Latest, with v1 still downloadable", async () => {
    expect(await submitFile("first cut of the deck")).toMatchObject({ ok: expect.any(String) });
    expect(await submitFile("second cut of the deck")).toMatchObject({ ok: expect.any(String) });

    const stored = await ctx.db.select().from(uploads);
    expect(stored).toHaveLength(2);
    const first = stored.find((row) => row.version === 1)!;
    const second = stored.find((row) => row.version === 2)!;
    expect(second.versionOf).toBe(first.id);
    expect(first.versionOf).toBeNull();

    // Both objects survive in storage — "new version", not "overwrite".
    expect(bucket.objects.has(first.key)).toBe(true);
    expect(bucket.objects.has(second.key)).toBe(true);
    expect(new TextDecoder().decode(bucket.objects.get(first.key))).toBe("first cut of the deck");

    const data = await loadTask();
    const history = data.histories.deliverable;
    expect(history.versions.map((version) => version.version)).toEqual([1, 2]);
    expect(history.versions[1].isLatest).toBe(true);
    expect(history.versions[0].isLatest).toBe(false);
    expect(history.versions[0].href).toBe(`/api/uploads/${first.id}`);
    // Uploader is resolved, not left blank — the organizer's mirror of this
    // list shows the same name, and a placeholder would read as "Unknown".
    expect(history.versions[0].uploaderName).toBe('Sam Speaker');

    // The task's answer points at the LATEST, so a plain download gets v2.
    const task = await ctx.db.query.tasks.findFirst({ where: eq(tasks.id, TASK_ID) });
    expect((task?.response as Record<string, string>).deliverable).toBe(second.id);
  });

  it("the organizer's library shows the same two versions as one deliverable", async () => {
    await submitFile("first cut");
    await submitFile("second cut");

    const { chains } = await adminLibrary();
    expect(chains).toHaveLength(1);
    expect(chains[0].versions).toHaveLength(2);
    expect(chains[0].latest.version).toBe(2);
    // MUST NOT FIRE: the superseded version is listed, not dropped.
    expect(chains[0].versions[0].version).toBe(1);
  });

  it("MUST NOT FIRE: another speaker's identical filename starts its own chain", async () => {
    await submitFile("mine", fixture.speakerIds[0], TASK_ID);
    await submitFile("theirs", fixture.speakerIds[1], OTHER_TASK_ID);

    const stored = await ctx.db.select().from(uploads);
    expect(stored).toHaveLength(2);
    expect(stored.every((row) => row.versionOf === null)).toBe(true);
    expect((await adminLibrary()).chains).toHaveLength(2);
  });
});

describe("file comments cross the role boundary (CNT-05)", () => {
  it("MUST FIRE: the organizer's comment appears on the speaker's own task page", async () => {
    await submitFile("the deck");
    const [file] = await ctx.db.select().from(uploads);

    const response = (await adminAction({
      request: await signedInPost(ADMIN_URL, fixture.adminId, {
        intent: "comment",
        uploadId: file.id,
        body: "Can you add the demo timings?",
      }),
      params: {},
      context: {},
    } as unknown as Parameters<typeof adminAction>[0])) as Response;
    expect(response.status).toBe(302);

    const history = (await loadTask()).histories.deliverable;
    expect(history.comments).toHaveLength(1);
    expect(history.comments[0].body).toBe("Can you add the demo timings?");
    expect(history.comments[0].authorName).toBe("Ada Organiser");
    expect(history.comments[0].createdAt).toBeGreaterThan(0);
  });

  it("MUST FIRE: the speaker's reply appears in the organizer's library", async () => {
    await submitFile("the deck");
    const [file] = await ctx.db.select().from(uploads);

    expect(
      await postToTask({
        intent: "comment",
        uploadId: file.id,
        body: "Draft deck — final version coming Friday.",
      }),
    ).toMatchObject({ ok: "Comment posted." });

    const [stored] = await ctx.db.select().from(uploadComments);
    expect(stored.authorId).toBe(fixture.speakerIds[0]);
    expect(stored.authorName).toBe("Sam Speaker");

    const { chains } = await adminLibrary();
    expect(chains[0].comments.map((comment) => comment.body)).toEqual([
      "Draft deck — final version coming Friday.",
    ]);
  });

  it("MUST NOT FIRE: a speaker cannot comment on another speaker's file", async () => {
    await submitFile("theirs", fixture.speakerIds[1], OTHER_TASK_ID);
    const [theirFile] = await ctx.db.select().from(uploads);

    // Hand-built POST from speaker 0 naming speaker 1's upload id — the exact
    // request the UI never offers and the server must still refuse.
    expect(
      await postToTask({ intent: "comment", uploadId: theirFile.id, body: "not mine" }),
    ).toMatchObject({ error: "That file is not yours to comment on." });
    expect(await ctx.db.select().from(uploadComments)).toHaveLength(0);
  });

  it("MUST NOT FIRE: a blank comment writes nothing", async () => {
    await submitFile("the deck");
    const [file] = await ctx.db.select().from(uploads);
    expect(await postToTask({ intent: "comment", uploadId: file.id, body: "  " })).toMatchObject({
      error: "Write a comment first.",
    });
    expect(await ctx.db.select().from(uploadComments)).toHaveLength(0);
  });

  /**
   * Attribution under impersonation.
   *
   * An organizer previewing a speaker's portal used to have their comment
   * stored as the SPEAKER: `addUploadComment` was passed `actor.person`, which
   * under impersonation is the target. Uploads on the same route already do the
   * opposite — `uploadedById` is `actor.impersonatedBy?.id ?? actor.person.id`,
   * with a comment saying the identifier must be the REAL caller. CNT-05's
   * whole value is a two-party thread the organizer also reads from
   * `/admin/files`, so words in it appearing under the wrong name is a
   * record-integrity defect, not a cosmetic one.
   */
  it("MUST FIRE: a comment written while impersonating is attributed to the ORGANIZER", async () => {
    await submitFile("the deck");
    const [file] = await ctx.db.select().from(uploads);

    const started = (await impersonateAction({
      request: await signedInPost("https://x.test/portal/impersonate", fixture.adminId, {
        personId: fixture.speakerIds[0],
      }),
      params: {},
      context: {},
    } as unknown as Parameters<typeof impersonateAction>[0])) as Response;
    const viewAs = started.headers.get("set-cookie")!.split(";")[0];

    const session = (await createLoginSession(new Request(TASK_URL), fixture.adminId)).split(";")[0];
    const result = await action({
      request: new Request(TASK_URL, {
        method: "POST",
        headers: {
          cookie: `${session}; ${viewAs}`,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          intent: "comment",
          uploadId: file.id,
          body: "Booked the confidence monitor for you.",
        }).toString(),
      }),
      params: { taskId: TASK_ID },
      context: {},
    } as unknown as ActionArgs);
    expect(result).toMatchObject({ ok: "Comment posted." });

    const [stored] = await ctx.db.select().from(uploadComments);
    expect(stored.authorId).toBe(fixture.adminId);
    expect(stored.authorName).toBe("Ada Organiser");
    // MUST NOT FIRE: it is not filed as the speaker on either field. The
    // denormalised name is checked separately because it is what actually
    // renders — an id-only fix would still show the wrong name on both pages.
    expect(stored.authorId).not.toBe(fixture.speakerIds[0]);
    expect(stored.authorName).not.toBe("Sam Speaker");

    // And the organizer's own library agrees, since it renders `authorName`.
    const { chains } = await adminLibrary();
    expect(chains[0].comments[0].authorName).toBe("Ada Organiser");
  });

  it("MUST NOT FIRE: without impersonation the speaker is still the author", async () => {
    await submitFile("the deck");
    const [file] = await ctx.db.select().from(uploads);

    await postToTask({ intent: "comment", uploadId: file.id, body: "Mine, written by me." });

    const [stored] = await ctx.db.select().from(uploadComments);
    expect(stored.authorId).toBe(fixture.speakerIds[0]);
    expect(stored.authorName).toBe("Sam Speaker");
  });
});

describe("upload constraints are stated at the control (CNT-06)", () => {
  it("MUST FIRE: the rendered task states the enforced cap and accepted types", async () => {
    const data = await loadTask();
    const question = data.form!.schema.questions[0];
    const html = renderToStaticMarkup(
      <QuestionField
        question={question}
        value={null}
        disabled={false}
        acceptDefault={data.acceptDefault}
      />,
    );

    expect(html).toContain(`up to ${MAX_UPLOAD_BYTES / 1024 / 1024} MB`);
    expect(html).toContain("PDF, PPT/PPTX");
    // MUST NOT FIRE: the copy is generated, so it cannot name a cap the server
    // does not enforce — 50 MB would be the classic hand-typed drift.
    expect(html).not.toContain("up to 50 MB");
  });
});
