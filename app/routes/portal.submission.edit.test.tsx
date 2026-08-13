import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { forms, people, sessionParticipants, sessions } from "~/db/schema";
import { listSessionRevisions } from "~/lib/admin/session-revisions.server";
import { canSpeakerEditSubmission } from "~/lib/portal/submission-edit";
import { loadSubmissions } from "~/lib/portal/portal.server";
import { signedInGet, signedInPost } from "~/test/auth";
import { installTestDb, type TestDbContext } from "~/test/db";
import {
  EVENT_ID,
  seedDemoFixture,
  type DemoFixture,
} from "~/test/fixtures";

import { action, loader } from "./portal.submission.edit";

type LoaderArgs = Parameters<typeof loader>[0];
type ActionArgs = Parameters<typeof action>[0];

const asLoaderArgs = (request: Request, sessionId: string) =>
  ({ request, params: { sessionId }, context: {} }) as unknown as LoaderArgs;
const asActionArgs = (request: Request, sessionId: string) =>
  ({ request, params: { sessionId }, context: {} }) as unknown as ActionArgs;

let ctx: TestDbContext;
let fixture: DemoFixture;

beforeEach(async () => {
  ctx = installTestDb();
  fixture = await seedDemoFixture(ctx.db);
});
afterEach(() => ctx.close());

async function loadAs(personId: string, sessionId: string) {
  const request = await signedInGet(
    `https://x.test/portal/submissions/${sessionId}/edit`,
    personId,
  );
  return loader(asLoaderArgs(request, sessionId));
}

async function postAs(
  personId: string,
  sessionId: string,
  fields: Record<string, string>,
) {
  const request = await signedInPost(
    `https://x.test/portal/submissions/${sessionId}/edit`,
    personId,
    fields,
  );
  return action(asActionArgs(request, sessionId));
}

function statusOf(result: unknown): number {
  if (result instanceof Response) return result.status;
  const init = (result as { init?: number | { status?: number } })?.init;
  return typeof init === "number" ? init : (init?.status ?? 200);
}

async function row(id: string) {
  return ctx.db.query.sessions.findFirst({ where: eq(sessions.id, id) });
}

async function setCloseAt(sessionId: string, closesAt: Date | null) {
  const target = await row(sessionId);
  await ctx.db
    .update(forms)
    .set({ closesAt })
    .where(eq(forms.id, target!.formId!));
}

const validAbstract =
  "A practical account of building reliable agent systems, including failure analysis, " +
  "evaluation design, operational trade-offs, deployment lessons, and concrete techniques " +
  "that attendees can apply to production systems immediately after the conference.";

describe("portal submission correction route", () => {
  it("lets the primary owner correct a pending proposal without mutating system fields", async () => {
    const target = fixture.abstractIds[3];
    const owner = fixture.speakerIds[3];
    const before = await row(target);
    const participantsBefore = await ctx.db.query.sessionParticipants.findMany({
      where: eq(sessionParticipants.sessionId, target),
    });
    const loaded = await loadAs(owner, target);

    const response = await postAs(owner, target, {
      expectedUpdatedAt: String(loaded.submission.updatedAt),
      title: "A corrected production-ready title",
      abstract: validAbstract,
      videoUrl: "https://video.example/private-pitch",
      status: "accepted",
      trackId: fixture.trackIds[2],
      formId: "forged-form",
    });

    expect(statusOf(response)).toBe(302);
    const after = await row(target);
    expect(after).toMatchObject({
      title: "A corrected production-ready title",
      description: validAbstract,
      videoUrl: "https://video.example/private-pitch",
      friendlyId: before?.friendlyId,
      status: before?.status,
      formId: before?.formId,
      trackId: before?.trackId,
      formatId: before?.formatId,
      composedIntoSessionId: before?.composedIntoSessionId,
    });
    expect(after?.answers).toMatchObject({
      ...(before?.answers as Record<string, unknown>),
      title: "A corrected production-ready title",
      abstract: validAbstract,
    });
    expect(await ctx.db.query.sessionParticipants.findMany({
      where: eq(sessionParticipants.sessionId, target),
    })).toEqual(participantsBefore);
  });

  it("MUST FIRE: accepted corrections update the abstract and connected programme content only", async () => {
    const target = fixture.abstractIds[0];
    const owner = fixture.speakerIds[0];
    const programId = fixture.programSessionIds[0];
    await setCloseAt(target, new Date(Date.now() - 60_000));

    const abstractBefore = await row(target);
    const programmeBefore = await row(programId);
    const loaded = await loadAs(owner, target);
    expect(loaded.submission).toMatchObject({
      editable: true,
      lockReason: null,
      status: "accepted",
    });
    expect(loaded.submission.programmeUpdatedAt).toBe(
      programmeBefore!.updatedAt.getTime(),
    );

    const result = await postAs(owner, target, {
      expectedUpdatedAt: String(loaded.submission.updatedAt),
      expectedProgrammeUpdatedAt: String(loaded.submission.programmeUpdatedAt),
      title: "Accepted title corrected by the speaker",
      abstract: validAbstract,
      videoUrl: "https://video.example/accepted-update",
      status: "declined",
      trackId: fixture.trackIds[2],
      roomId: fixture.roomIds[2],
    });

    expect(statusOf(result)).toBe(302);
    const abstractAfter = await row(target);
    const programmeAfter = await row(programId);
    expect(abstractAfter).toMatchObject({
      title: "Accepted title corrected by the speaker",
      description: validAbstract,
      videoUrl: "https://video.example/accepted-update",
      status: "accepted",
      trackId: abstractBefore!.trackId,
      composedIntoSessionId: programId,
    });
    expect(programmeAfter).toMatchObject({
      title: "Accepted title corrected by the speaker",
      description: validAbstract,
      status: "accepted",
      trackId: programmeBefore!.trackId,
      roomId: programmeBefore!.roomId,
      startsAt: programmeBefore!.startsAt,
      endsAt: programmeBefore!.endsAt,
      capacity: programmeBefore!.capacity,
      isPublic: programmeBefore!.isPublic,
      publishedAt: programmeBefore!.publishedAt,
    });
    expect(programmeAfter?.videoUrl).toBe(programmeBefore?.videoUrl);
  });

  /*
   * The organizer's history panel is only honest if the SPEAKER'S own correction
   * path writes to it too. A speaker edit that silently skipped the revision log
   * would leave the panel claiming the last change was the organizer's.
   *
   * The complement is the test below it: the same POST, refused for a stale
   * write, must leave the log untouched — otherwise "a revision exists" would
   * only prove the route was reached, not that the content actually changed.
   */
  it("MUST FIRE: a speaker correction records an attributed portal_edit revision on both rows", async () => {
    const target = fixture.abstractIds[0];
    const owner = fixture.speakerIds[0];
    const programId = fixture.programSessionIds[0];
    await setCloseAt(target, new Date(Date.now() - 60_000));

    const before = await listSessionRevisions(target, EVENT_ID);
    const ownerPerson = await ctx.db.query.people.findFirst({
      where: eq(people.id, owner),
    });
    const expectedName = ownerPerson!.fullName ?? ownerPerson!.email;

    const loaded = await loadAs(owner, target);
    const result = await postAs(owner, target, {
      expectedUpdatedAt: String(loaded.submission.updatedAt),
      expectedProgrammeUpdatedAt: String(loaded.submission.programmeUpdatedAt),
      title: "Speaker-corrected title for the history panel",
      abstract: validAbstract,
      videoUrl: "",
    });
    expect(statusOf(result)).toBe(302);

    const abstractHistory = await listSessionRevisions(target, EVENT_ID);
    const programmeHistory = await listSessionRevisions(programId, EVENT_ID);
    expect(abstractHistory).toHaveLength(before.length + 1);
    expect(abstractHistory[0]).toMatchObject({
      title: "Speaker-corrected title for the history panel",
      description: validAbstract,
      editorPersonId: owner,
      editorName: expectedName,
      source: "portal_edit",
    });
    // The composed programme row is the one the public schedule reads, so its
    // history has to move in lockstep or the two panels would disagree.
    expect(programmeHistory[0]).toMatchObject({
      title: "Speaker-corrected title for the history panel",
      editorPersonId: owner,
      source: "portal_edit",
    });
  });

  it("MUST NOT FIRE: a rejected stale correction writes no revision", async () => {
    const target = fixture.abstractIds[0];
    const owner = fixture.speakerIds[0];
    const programId = fixture.programSessionIds[0];
    const loaded = await loadAs(owner, target);

    await ctx.db
      .update(sessions)
      .set({
        roomId: fixture.roomIds[2],
        updatedAt: new Date(loaded.submission.programmeUpdatedAt! + 1),
      })
      .where(eq(sessions.id, programId));
    const before = await listSessionRevisions(target, EVENT_ID);

    const result = await postAs(owner, target, {
      expectedUpdatedAt: String(loaded.submission.updatedAt),
      expectedProgrammeUpdatedAt: String(loaded.submission.programmeUpdatedAt),
      title: "Stale speaker overwrite that must not be logged",
      abstract: validAbstract,
      videoUrl: "",
    });

    expect(statusOf(result)).toBe(409);
    const after = await listSessionRevisions(target, EVENT_ID);
    expect(after).toHaveLength(before.length);
    expect(after.map((revision) => revision.title)).not.toContain(
      "Stale speaker overwrite that must not be logged",
    );
  });

  it("MUST NOT FIRE: a concurrent programme change rejects both speaker writes", async () => {
    const target = fixture.abstractIds[0];
    const owner = fixture.speakerIds[0];
    const programId = fixture.programSessionIds[0];
    const loaded = await loadAs(owner, target);

    await ctx.db
      .update(sessions)
      .set({
        roomId: fixture.roomIds[2],
        updatedAt: new Date(loaded.submission.programmeUpdatedAt! + 1),
      })
      .where(eq(sessions.id, programId));
    const abstractBefore = await row(target);
    const programmeBefore = await row(programId);

    const result = await postAs(owner, target, {
      expectedUpdatedAt: String(loaded.submission.updatedAt),
      expectedProgrammeUpdatedAt: String(loaded.submission.programmeUpdatedAt),
      title: "Stale accepted speaker overwrite",
      abstract: validAbstract,
      videoUrl: "",
    });

    expect(statusOf(result)).toBe(409);
    expect(await row(target)).toEqual(abstractBefore);
    expect(await row(programId)).toEqual(programmeBefore);
  });

  it("MUST NOT FIRE: an accepted row without its programme session stays locked", async () => {
    const target = fixture.abstractIds[3];
    const owner = fixture.speakerIds[3];
    await ctx.db
      .update(sessions)
      .set({ status: "accepted", composedIntoSessionId: null })
      .where(eq(sessions.id, target));
    const before = await row(target);

    const loaded = await loadAs(owner, target);
    expect(loaded.submission).toMatchObject({
      editable: false,
      lockReason: "programme_missing",
    });
    const result = await postAs(owner, target, {
      expectedUpdatedAt: String(loaded.submission.updatedAt),
      title: "Must not land without a programme row",
      abstract: validAbstract,
      videoUrl: "",
    });
    expect(statusOf(result)).toBe(409);
    expect(await row(target)).toEqual(before);
  });

  it("locks a pending proposal after the owning CFP deadline", async () => {
    const target = fixture.abstractIds[3];
    const owner = fixture.speakerIds[3];
    await setCloseAt(target, new Date(Date.now() - 60_000));
    const before = await row(target);

    const loaded = await loadAs(owner, target);
    expect(loaded.submission).toMatchObject({
      editable: false,
      lockReason: "past_close_date",
    });

    const result = await postAs(owner, target, {
      expectedUpdatedAt: String(loaded.submission.updatedAt),
      title: "Must not land after close",
      abstract: validAbstract,
      videoUrl: "",
    });

    expect(statusOf(result)).toBe(409);
    expect(result).toMatchObject({
      data: {
        errors: {
          form: "Editing is closed because this CFP deadline has passed.",
        },
      },
    });
    expect(await row(target)).toEqual(before);
  });

  it("allows a pending proposal while the owning CFP deadline is still future", async () => {
    const target = fixture.abstractIds[3];
    const owner = fixture.speakerIds[3];
    await setCloseAt(target, new Date(Date.now() + 60_000));

    const loaded = await loadAs(owner, target);
    expect(loaded.submission).toMatchObject({
      editable: true,
      lockReason: null,
    });

    const result = await postAs(owner, target, {
      expectedUpdatedAt: String(loaded.submission.updatedAt),
      title: "Allowed before close",
      abstract: validAbstract,
      videoUrl: "",
    });

    expect(statusOf(result)).toBe(302);
    expect((await row(target))?.title).toBe("Allowed before close");
  });

  it("grandfathers untouched historical answers but enforces editable CFP constraints", async () => {
    const target = fixture.abstractIds[3];
    const owner = fixture.speakerIds[3];
    const form = await ctx.db.query.forms.findFirst({
      where: eq(forms.id, (await row(target))!.formId!),
    });
    const schema = form!.schema as {
      fields: Array<Record<string, unknown>>;
      [key: string]: unknown;
    };
    await ctx.db
      .update(forms)
      .set({
        schema: {
          ...schema,
          fields: schema.fields.map((field) =>
            field.key === "takeaways"
              ? {
                  ...field,
                  validation: {
                    ...((field.validation as Record<string, unknown> | undefined) ?? {}),
                    minLength: 500,
                  },
                }
              : field,
          ),
        },
      })
      .where(eq(forms.id, form!.id));

    const loaded = await loadAs(owner, target);
    const tooShort = await postAs(owner, target, {
      expectedUpdatedAt: String(loaded.submission.updatedAt),
      title: "Still a valid title",
      abstract: "Too short",
      videoUrl: "",
    });
    expect(statusOf(tooShort)).toBe(400);
    expect((await row(target))?.title).not.toBe("Still a valid title");

    const ok = await postAs(owner, target, {
      expectedUpdatedAt: String(loaded.submission.updatedAt),
      title: "A valid correction despite an evolved form",
      abstract: validAbstract,
      videoUrl: "",
    });
    expect(statusOf(ok)).toBe(302);
    expect((await row(target))?.title).toBe(
      "A valid correction despite an evolved form",
    );
  });

  it("rejects a correction that introduces a new conditional-field error", async () => {
    const target = fixture.abstractIds[3];
    const owner = fixture.speakerIds[3];
    const form = await ctx.db.query.forms.findFirst({
      where: eq(forms.id, (await row(target))!.formId!),
    });
    const schema = form!.schema as {
      rules: Array<Record<string, unknown>>;
      [key: string]: unknown;
    };
    await ctx.db
      .update(forms)
      .set({
        schema: {
          ...schema,
          rules: [
            ...schema.rules,
            {
              id: "workshop-needs-benchmark",
              match: "all",
              when: [{ fieldKey: "title", op: "contains", value: "Workshop" }],
              action: "require",
              targetKeys: ["benchmark_url"],
              scope: "submission",
              enabled: true,
            },
          ],
        },
      })
      .where(eq(forms.id, form!.id));

    const loaded = await loadAs(owner, target);
    const result = await postAs(owner, target, {
      expectedUpdatedAt: String(loaded.submission.updatedAt),
      title: "Workshop without the required benchmark",
      abstract: validAbstract,
      videoUrl: "",
    });

    expect(statusOf(result)).toBe(400);
    expect((await row(target))?.title).not.toContain("Workshop without");
  });

  it("mirrors a newly supplied form-defined video link into flat answers", async () => {
    const target = fixture.abstractIds[4];
    const owner = fixture.speakerIds[4];
    expect((await row(target))?.answers).not.toHaveProperty("video_url");
    const loaded = await loadAs(owner, target);

    const result = await postAs(owner, target, {
      expectedUpdatedAt: String(loaded.submission.updatedAt),
      title: "A video-first correction",
      abstract: "",
      videoUrl: "https://video.example/new-pitch",
    });

    expect(statusOf(result)).toBe(302);
    const after = await row(target);
    expect(after?.videoUrl).toBe("https://video.example/new-pitch");
    expect(after?.answers).toHaveProperty(
      "video_url",
      "https://video.example/new-pitch",
    );
  });

  it("returns 404 to unrelated speakers and pending co-speakers", async () => {
    const target = fixture.abstractIds[3];
    const stranger = fixture.speakerIds[4];
    const coSpeaker = fixture.speakerIds[6];

    await ctx.db.insert(sessionParticipants).values({
      sessionId: target,
      personId: coSpeaker,
      role: "co_speaker",
      isPrimary: false,
      order: 1,
    });

    await expect(loadAs(stranger, target)).rejects.toMatchObject({ status: 404 });
    await expect(loadAs(coSpeaker, target)).rejects.toMatchObject({ status: 404 });

    const summaries = await loadSubmissions(coSpeaker, EVENT_ID);
    const summary = summaries.find((item) => item.id === target);
    expect(summary?.isPrimary).toBe(false);
    expect(canSpeakerEditSubmission(summary!.status) && summary?.isPrimary === true).toBe(false);
  });

  it("rejects stale edits and preserves the intervening write", async () => {
    const target = fixture.abstractIds[4];
    const owner = fixture.speakerIds[4];
    const loaded = await loadAs(owner, target);
    const old = loaded.submission.updatedAt;

    await ctx.db
      .update(sessions)
      .set({
        title: "Organizer correction wins",
        updatedAt: new Date(old + 1),
      })
      .where(eq(sessions.id, target));

    const stale = await postAs(owner, target, {
      expectedUpdatedAt: String(old),
      title: "Stale speaker overwrite",
      abstract: validAbstract,
      videoUrl: "",
    });

    expect(statusOf(stale)).toBe(409);
    expect((await row(target))?.title).toBe("Organizer correction wins");
  });

  it.each(["accept_queue", "decline_queue", "declined", "withdrawn"] as const)(
    "locks a %s proposal and leaves its content unchanged",
    async (status) => {
      const target = fixture.abstractIds[3];
      const owner = fixture.speakerIds[3];
      await ctx.db.update(sessions).set({ status }).where(eq(sessions.id, target));
      const before = await row(target);
      const loaded = await loadAs(owner, target);

      const result = await postAs(owner, target, {
        expectedUpdatedAt: String(loaded.submission.updatedAt),
        title: "Must not land",
        abstract: validAbstract,
        videoUrl: "",
      });

      expect(statusOf(result)).toBe(409);
      expect(await row(target)).toEqual(before);
    },
  );

  it("requires an event-owned CFP form", async () => {
    const target = fixture.abstractIds[3];
    const owner = fixture.speakerIds[3];
    await ctx.db
      .update(forms)
      .set({ surface: "portal" })
      .where(eq(forms.id, (await row(target))!.formId!));

    await expect(loadAs(owner, target)).rejects.toMatchObject({ status: 404 });
  });
});
