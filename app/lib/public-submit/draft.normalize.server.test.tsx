import { renderToStaticMarkup } from "react-dom/server";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  events,
  fields as fieldsTable,
  forms,
  levels,
  people,
  sessionParticipants,
  sessions,
} from "~/db/schema";
import { loadSubmissions } from "~/lib/portal/portal.server";
import {
  SubmissionDetailView,
  loader as adminDetailLoader,
  submissionLoaderPayload,
} from "~/routes/admin.submission";
import { action as adminSubmissionsAction } from "~/routes/admin.submissions";
import { signedInGet, signedInPost } from "~/test/auth";
import { installTestDb, type TestDbContext } from "~/test/db";
import { CFP_FORM_ID, EVENT_ID, seedDemoFixture, type DemoFixture } from "~/test/fixtures";

import { toFormDefinition } from "./contract";
import { submitDraft, type DraftView } from "./draft.server";

type AdminDetailArgs = Parameters<typeof adminDetailLoader>[0];
type AdminSubmissionsActionArgs = Parameters<typeof adminSubmissionsAction>[0];

const LEVEL_ID = "level-intermediate";
const LEVEL_FIELD_ID = "field-level";

let ctx: TestDbContext;
let fixture: DemoFixture;

beforeEach(async () => {
  ctx = installTestDb();
  fixture = await seedDemoFixture(ctx.db);
});
afterEach(() => ctx.close());

async function addLevelField() {
  const form = await ctx.db.query.forms.findFirst({ where: eq(forms.id, CFP_FORM_ID) });
  const schema = form!.schema as Record<string, unknown> & { fields?: unknown[] };

  await ctx.db.insert(levels).values({
    id: LEVEL_ID,
    eventId: EVENT_ID,
    name: "Intermediate",
    order: 0,
  });
  await ctx.db.insert(fieldsTable).values({
    id: LEVEL_FIELD_ID,
    eventId: EVENT_ID,
    module: "session",
    key: "level",
    label: "Level",
    type: "select",
    constraints: { required: false, options: ["Intermediate"] },
    order: 8,
  });
  await ctx.db
    .update(forms)
    .set({
      schema: {
        ...schema,
        fields: [
          ...(schema.fields ?? []),
          {
            fieldId: LEVEL_FIELD_ID,
            key: "level",
            type: "select",
            label: "Level",
            scope: "submission",
            order: 8,
            required: false,
            validation: { options: ["Intermediate"] },
          },
        ],
      },
    })
    .where(eq(forms.id, CFP_FORM_ID));
}

async function submitPublic(
  answers: Record<string, string>,
  existingIds: { formatId?: string; levelId?: string } = {},
) {
  await addLevelField();

  const submitterId = fixture.speakerIds[0];
  const draftId = crypto.randomUUID();
  const participants: DraftView["participants"] = [
    {
      role: "speaker",
      firstName: "Sam",
      lastName: "Speaker",
      email: "speaker@callboard.dev",
      bio: "",
      isPrimary: true,
      answers: {},
    },
  ];
  await ctx.db.insert(sessions).values({
    id: draftId,
    eventId: EVENT_ID,
    formId: CFP_FORM_ID,
    title: answers.title,
    status: "draft",
    isAbstract: true,
    answers: { fields: answers, participants, __content: {} },
    ...existingIds,
  });
  await ctx.db.insert(sessionParticipants).values({
    sessionId: draftId,
    personId: submitterId,
    role: "speaker",
    isPrimary: true,
    order: 0,
  });

  const [event, form, submitter] = await Promise.all([
    ctx.db.query.events.findFirst({ where: eq(events.id, EVENT_ID) }),
    ctx.db.query.forms.findFirst({ where: eq(forms.id, CFP_FORM_ID) }),
    ctx.db.query.people.findFirst({ where: eq(people.id, submitterId) }),
  ]);
  const draft: DraftView = {
    id: draftId,
    status: "draft",
    title: answers.title,
    fields: answers,
    participants,
    content: {
      mode: "abstract",
      videoUrl: "",
      uploadKey: null,
      uploadName: null,
      uploadSize: null,
    },
  };

  const result = await submitDraft({
    request: new Request("https://x.test/submit"),
    event: event!,
    form: form!,
    def: toFormDefinition(form!),
    draft,
    submitter: submitter!,
  });
  return { answers, draftId, result, submitterId };
}

async function loadAdminDetail(id: string) {
  const request = await signedInGet(`https://x.test/admin/submissions/${id}`, fixture.adminId);
  return submissionLoaderPayload(
    await adminDetailLoader({
      request,
      params: { id },
      context: {},
    } as unknown as AdminDetailArgs),
  );
}

describe("submitDraft named-option normalization", () => {
  it("must fire: writes the exact event format and level ids without changing answers", async () => {
    const submitted = await submitPublic({
      title: "Normalized metadata",
      abstract: "A public CFP abstract.",
      format: "Talk",
      level: "Intermediate",
    });

    expect(submitted.result.ok).toBe(true);
    const row = await ctx.db.query.sessions.findFirst({
      where: eq(sessions.id, submitted.draftId),
    });
    expect(row?.formatId).toBe(fixture.formatIds[0]);
    expect(row?.levelId).toBe(LEVEL_ID);
    expect(row?.answers).toEqual(submitted.answers);

    const detail = await loadAdminDetail(submitted.draftId);
    expect(detail.detail?.formatName).toBe("Talk");
    expect(detail.detail?.levelName).toBe("Intermediate");
    const html = renderToStaticMarkup(<SubmissionDetailView {...detail} />);
    expect(html).toMatch(/>Format<\/dt><dd[^>]*>Talk<\/dd>/);
    expect(html).toMatch(/>Level<\/dt><dd[^>]*>Intermediate<\/dd>/);

    const portalRows = await loadSubmissions(submitted.submitterId, EVENT_ID);
    expect(portalRows.find((item) => item.id === submitted.draftId)?.format).toBe("Talk");
  });

  it("must NOT fire: an unknown format stays null, succeeds, and remains raw display text", async () => {
    const submitted = await submitPublic({
      title: "Unregistered format",
      abstract: "A public CFP abstract.",
      format: "Fireside chat",
      level: "Expert",
    });

    expect(submitted.result.ok).toBe(true);
    const row = await ctx.db.query.sessions.findFirst({
      where: eq(sessions.id, submitted.draftId),
    });
    expect(row?.formatId).toBeNull();
    expect(row?.levelId).toBeNull();
    expect(row?.answers).toEqual(submitted.answers);

    // Display-only legacy fallback: preserve the submitted string, do not make a row.
    const detail = await loadAdminDetail(submitted.draftId);
    expect(detail.detail?.formatName).toBe("Fireside chat");
    expect(detail.detail?.levelName).toBe("Expert");
    const portalRows = await loadSubmissions(submitted.submitterId, EVENT_ID);
    expect(portalRows.find((item) => item.id === submitted.draftId)?.format).toBe(
      "Fireside chat",
    );
  });

  it("must NOT fire: unmatched answers do not clear ids already stored on the draft", async () => {
    const submitted = await submitPublic(
      {
        title: "Preserved metadata",
        abstract: "A public CFP abstract.",
        format: "Not configured",
      },
      { formatId: fixture.formatIds[2] },
    );

    expect(submitted.result.ok).toBe(true);
    const row = await ctx.db.query.sessions.findFirst({
      where: eq(sessions.id, submitted.draftId),
    });
    expect(row?.formatId).toBe(fixture.formatIds[2]);
  });

  it("must NOT fire: the admin create path still stores its selected format id directly", async () => {
    const request = await signedInPost(
      "https://x.test/admin/submissions",
      fixture.adminId,
      {
        intent: "create-record",
        kind: "abstract",
        title: "Admin-created with a format",
        status: "pending",
        formatId: fixture.formatIds[1],
      },
    );
    const response = (await adminSubmissionsAction({
      request,
      params: {},
      context: {},
    } as unknown as AdminSubmissionsActionArgs)) as Response;
    expect(response.status).toBe(302);

    const created = await ctx.db.query.sessions.findFirst({
      where: eq(sessions.title, "Admin-created with a format"),
    });
    expect(created?.formatId).toBe(fixture.formatIds[1]);
    expect(created?.answers).toBeNull();
  });
});
