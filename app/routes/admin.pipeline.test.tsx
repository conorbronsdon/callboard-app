import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DndPipelineBoard, pipelineDropIntent } from "~/components/pipeline-board";
import {
  PIPELINE_STAGE_LABELS,
  PIPELINE_STAGES,
  pipelineEntries,
  stageTransitions,
} from "~/db/schema";
import { enrollContact } from "~/lib/pipeline.server";
import { signedInGet, signedInPost } from "~/test/auth";
import { installTestDb, type TestDbContext } from "~/test/db";
import { EVENT_SLUG, seedDemoFixture, type DemoFixture } from "~/test/fixtures";

import {
  PipelineBoardScreen,
  action as pipelineAction,
  loader as pipelineLoader,
} from "./admin.pipeline";
import { action as contactsAction } from "./admin.contacts";
import { action as detailAction } from "./admin.contacts.detail";
import { loader as portalLoader } from "./portal.index";
import { loader as publicSpeakersLoader } from "./public.speakers";

type PipelineLoaderArgs = Parameters<typeof pipelineLoader>[0];
type PipelineActionArgs = Parameters<typeof pipelineAction>[0];
type ContactsActionArgs = Parameters<typeof contactsAction>[0];
type DetailActionArgs = Parameters<typeof detailAction>[0];

const PIPELINE_URL = "https://x.test/admin/pipeline";
const CONTACTS_URL = "https://x.test/admin/contacts";
const PIPELINE_SOURCE = readFileSync(
  fileURLToPath(new URL("./admin.pipeline.tsx", import.meta.url)),
  "utf8",
);
const PIPELINE_BOARD_SOURCE = readFileSync(
  fileURLToPath(new URL("../components/pipeline-board.tsx", import.meta.url)),
  "utf8",
);

const asPipelineLoaderArgs = (request: Request) =>
  ({ request, params: {}, context: {} }) as unknown as PipelineLoaderArgs;
const asPipelineActionArgs = (request: Request) =>
  ({ request, params: {}, context: {} }) as unknown as PipelineActionArgs;
const asContactsActionArgs = (request: Request) =>
  ({ request, params: {}, context: {} }) as unknown as ContactsActionArgs;
const asDetailActionArgs = (request: Request, id: string) =>
  ({ request, params: { id }, context: {} }) as unknown as DetailActionArgs;

let ctx: TestDbContext;
let fixture: DemoFixture;

beforeEach(async () => {
  ctx = installTestDb();
  fixture = await seedDemoFixture(ctx.db);
});
afterEach(() => ctx.close());

async function loadPipeline(personId = fixture.adminId) {
  return pipelineLoader(
    asPipelineLoaderArgs(await signedInGet(PIPELINE_URL, personId)),
  );
}

async function postPipeline(fields: Record<string, string>, personId = fixture.adminId) {
  return pipelineAction(
    asPipelineActionArgs(await signedInPost(PIPELINE_URL, personId, fields)),
  );
}

async function postContacts(fields: Record<string, string>, personId = fixture.adminId) {
  return contactsAction(
    asContactsActionArgs(await signedInPost(CONTACTS_URL, personId, fields)),
  );
}

async function postDetail(
  id: string,
  fields: Record<string, string>,
  personId = fixture.adminId,
) {
  return detailAction(
    asDetailActionArgs(
      await signedInPost(`${CONTACTS_URL}/${id}`, personId, fields),
      id,
    ),
  );
}

function anonymousPost(url: string, fields: Record<string, string>) {
  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields).toString(),
  });
}

async function entryFor(personId: string) {
  const entry = await ctx.db.query.pipelineEntries.findFirst({
    where: eq(pipelineEntries.personId, personId),
  });
  expect(entry, `pipeline entry for ${personId}`).toBeDefined();
  return entry!;
}

async function transitionsFor(entryId: string) {
  return ctx.db
    .select({
      id: stageTransitions.id,
      fromStage: stageTransitions.fromStage,
      toStage: stageTransitions.toStage,
    })
    .from(stageTransitions)
    .where(eq(stageTransitions.entryId, entryId));
}

async function enroll(personId: string, stage = "prospect") {
  const result = await enrollContact(ctx.db, {
    personId,
    stage,
    score: 42,
    rationale: "Route-suite enrollment",
    movedByPersonId: fixture.adminId,
  });
  expect(result).toMatchObject({ ok: true });
  return result.ok ? result.entryId : "";
}

describe("pipeline transitions", () => {
  it("MUST FIRE: a dnd-shaped POST and button-shaped POST write identical attributed audits", async () => {
    const dndEntryId = await enroll(fixture.speakerIds[0]);
    const buttonEntryId = await enroll(fixture.speakerIds[1]);
    const dndFields = pipelineDropIntent(dndEntryId, "contacted", PIPELINE_STAGES);
    expect(dndFields).toEqual({
      intent: "move",
      entryId: dndEntryId,
      stage: "contacted",
    });

    expect(await postPipeline(dndFields!, fixture.adminId)).toMatchObject({
      ok: true,
      moved: true,
    });
    expect(
      await postPipeline(
        { intent: "move", entryId: buttonEntryId, stage: "contacted" },
        fixture.adminId,
      ),
    ).toMatchObject({ ok: true, moved: true });

    const movedAuditFor = async (entryId: string) => {
      const rows = await ctx.db
        .select({
          fromStage: stageTransitions.fromStage,
          toStage: stageTransitions.toStage,
          movedByPersonId: stageTransitions.movedByPersonId,
        })
        .from(stageTransitions)
        .where(eq(stageTransitions.entryId, entryId));
      return rows.find((row) => row.fromStage !== null);
    };
    const expectedAudit = {
      fromStage: "prospect",
      toStage: "contacted",
      movedByPersonId: fixture.adminId,
    };
    const dndAudit = await movedAuditFor(dndEntryId);
    const buttonAudit = await movedAuditFor(buttonEntryId);

    expect(dndAudit).toEqual(expectedAudit);
    expect(buttonAudit).toEqual(expectedAudit);
    expect(dndAudit).toEqual(buttonAudit);
  });

  it("MUST FIRE: enrolling then moving prospect to contacted writes the exact pair", async () => {
    const personId = fixture.speakerIds[0];
    await postDetail(personId, { intent: "enroll-pipeline", stage: "prospect" });
    const entry = await entryFor(personId);

    expect(
      await postPipeline({ intent: "move", entryId: entry.id, stage: "contacted" }),
    ).toMatchObject({ ok: true, moved: true });

    const transitions = await transitionsFor(entry.id);
    expect(transitions).toHaveLength(2);
    expect(transitions.find((row) => row.toStage === "contacted")).toMatchObject({
      fromStage: "prospect",
      toStage: "contacted",
    });
  });

  it("MUST FIRE: a second move chains from contacted and persists confirmed", async () => {
    const personId = fixture.speakerIds[0];
    const entryId = await enroll(personId);
    await postPipeline({ intent: "move", entryId, stage: "contacted" });
    await postPipeline({ intent: "move", entryId, stage: "confirmed" });

    const transitions = await transitionsFor(entryId);
    expect(transitions).toHaveLength(3);
    expect(transitions.find((row) => row.toStage === "confirmed")).toMatchObject({
      fromStage: "contacted",
      toStage: "confirmed",
    });
    expect((await entryFor(personId)).stage).toBe("confirmed");
  });

  it("MUST NOT FIRE: moving to the current stage writes no transition", async () => {
    const personId = fixture.speakerIds[0];
    const entryId = await enroll(personId);
    const before = await transitionsFor(entryId);

    expect(
      await postPipeline({ intent: "move", entryId, stage: "prospect" }),
    ).toMatchObject({ ok: true, moved: false });
    expect(await transitionsFor(entryId)).toHaveLength(before.length);
  });

  it("MUST NOT FIRE: a garbage stage changes neither entry nor history", async () => {
    const personId = fixture.speakerIds[0];
    const entryId = await enroll(personId);

    expect(
      await postPipeline({ intent: "move", entryId, stage: "not-a-stage" }),
    ).toEqual({ ok: false, error: "Choose a valid sourcing stage." });
    expect((await entryFor(personId)).stage).toBe("prospect");
    expect(await transitionsFor(entryId)).toHaveLength(1);
  });
});

describe("double enrollment", () => {
  it("MUST NOT FIRE: the same contact cannot be enrolled twice", async () => {
    const personId = fixture.speakerIds[0];
    expect(await postContacts({ intent: "enroll", personId })).toMatchObject({ ok: true });
    expect(await postContacts({ intent: "enroll", personId })).toMatchObject({
      ok: false,
      error: "Sam Speaker is already in the sourcing pipeline.",
    });

    const entries = await ctx.db
      .select()
      .from(pipelineEntries)
      .where(eq(pipelineEntries.personId, personId));
    expect(entries).toHaveLength(1);
    expect(await transitionsFor(entries[0].id)).toHaveLength(1);
  });

  it("MUST STILL FIRE: a different contact can enroll after a duplicate rejection", async () => {
    const first = fixture.speakerIds[0];
    const second = fixture.speakerIds[1];
    await postContacts({ intent: "enroll", personId: first });
    await postContacts({ intent: "enroll", personId: first });

    expect(await postContacts({ intent: "enroll", personId: second })).toMatchObject({
      ok: true,
    });
    expect(await ctx.db.select().from(pipelineEntries)).toHaveLength(2);
  });
});

type ProtectedRoute =
  | "pipeline loader"
  | "pipeline move"
  | "pipeline remove"
  | "contacts enroll"
  | "detail enroll-pipeline"
  | "detail move-pipeline"
  | "detail remove-pipeline";

const PROTECTED_ROUTES: ProtectedRoute[] = [
  "pipeline loader",
  "pipeline move",
  "pipeline remove",
  "contacts enroll",
  "detail enroll-pipeline",
  "detail move-pipeline",
  "detail remove-pipeline",
];

async function runProtectedRoute(route: ProtectedRoute, actorId: string | null) {
  const targetId = fixture.speakerIds[1];
  const get = async (url: string) =>
    actorId ? signedInGet(url, actorId) : new Request(url);
  const post = async (url: string, fields: Record<string, string>) =>
    actorId ? signedInPost(url, actorId, fields) : anonymousPost(url, fields);

  if (route === "pipeline loader") {
    return pipelineLoader(asPipelineLoaderArgs(await get(PIPELINE_URL)));
  }
  if (route === "contacts enroll") {
    return contactsAction(
      asContactsActionArgs(
        await post(CONTACTS_URL, { intent: "enroll", personId: targetId }),
      ),
    );
  }
  if (route === "detail enroll-pipeline") {
    return detailAction(
      asDetailActionArgs(
        await post(`${CONTACTS_URL}/${targetId}`, {
          intent: "enroll-pipeline",
          stage: "prospect",
        }),
        targetId,
      ),
    );
  }

  const entryId = await enroll(targetId);
  if (route === "pipeline move" || route === "pipeline remove") {
    const intent = route === "pipeline move" ? "move" : "remove";
    return pipelineAction(
      asPipelineActionArgs(
        await post(PIPELINE_URL, {
          intent,
          entryId,
          ...(intent === "move" ? { stage: "contacted" } : {}),
        }),
      ),
    );
  }

  const intent = route === "detail move-pipeline" ? "move-pipeline" : "remove-pipeline";
  return detailAction(
    asDetailActionArgs(
      await post(`${CONTACTS_URL}/${targetId}`, {
        intent,
        ...(intent === "move-pipeline" ? { stage: "contacted" } : {}),
      }),
      targetId,
    ),
  );
}

async function expectThrownResponse(
  run: () => Promise<unknown>,
  status: number,
): Promise<Response> {
  try {
    await run();
  } catch (error) {
    expect(error).toBeInstanceOf(Response);
    expect((error as Response).status).toBe(status);
    return error as Response;
  }
  throw new Error(`Expected a thrown ${status} Response`);
}

describe("server-side authorization", () => {
  const rejectionMatrix = PROTECTED_ROUTES.flatMap((route) => [
    { route, actorLabel: "signed-in speaker", actor: "speaker" as const, status: 403 },
    { route, actorLabel: "anonymous request", actor: "anonymous" as const, status: 302 },
  ]);

  it.each(rejectionMatrix)(
    "MUST NOT FIRE: $actorLabel cannot access $route",
    async ({ route, actor, status }) => {
      const actorId = actor === "speaker" ? fixture.speakerIds[0] : null;
      const response = await expectThrownResponse(
        () => runProtectedRoute(route, actorId),
        status,
      );
      if (actor === "anonymous") {
        expect(response.headers.get("location")).toMatch(/\/login/);
      }
    },
  );

  it.each(PROTECTED_ROUTES)(
    "MUST STILL FIRE: an admin can access %s",
    async (route) => {
      const result = await runProtectedRoute(route, fixture.adminId);
      if (route === "pipeline loader") {
        expect(result).toMatchObject({ columns: expect.any(Array) });
      } else {
        expect(result).toMatchObject({ ok: true });
      }
    },
  );

  it("MUST NOT FIRE: a rejected speaker move cannot write before the 403", async () => {
    const personId = fixture.speakerIds[1];
    const entryId = await enroll(personId);
    const before = await transitionsFor(entryId);
    const request = await signedInPost(PIPELINE_URL, fixture.speakerIds[0], {
      intent: "move",
      entryId,
      stage: "confirmed",
    });

    await expectThrownResponse(
      () => pipelineAction(asPipelineActionArgs(request)),
      403,
    );
    expect((await entryFor(personId)).stage).toBe("prospect");
    expect(await transitionsFor(entryId)).toHaveLength(before.length);
  });
});

describe("removal tombstones active enrollment", () => {
  it("MUST FIRE: removal deletes the entry while preserving its transition values", async () => {
    const personId = fixture.speakerIds[0];
    const entryId = await enroll(personId);
    await postPipeline({ intent: "move", entryId, stage: "contacted" });
    const before = await transitionsFor(entryId);

    expect(await postPipeline({ intent: "remove", entryId })).toMatchObject({ ok: true });
    expect(
      await ctx.db.query.pipelineEntries.findFirst({
        where: eq(pipelineEntries.id, entryId),
      }),
    ).toBeUndefined();
    const after = await transitionsFor(entryId);
    expect(after).toHaveLength(before.length);
    expect(after.map((row) => row.toStage).sort()).toEqual(
      before.map((row) => row.toStage).sort(),
    );
  });

  it("MUST FIRE: re-enrollment gets a new id and grows history beside the old log", async () => {
    const personId = fixture.speakerIds[0];
    const oldEntryId = await enroll(personId);
    await postPipeline({ intent: "move", entryId: oldEntryId, stage: "declined" });
    await postPipeline({ intent: "remove", entryId: oldEntryId });
    const oldTransitions = await transitionsFor(oldEntryId);

    const result = await postContacts({ intent: "enroll", personId });
    expect(result).toMatchObject({ ok: true });
    const newEntry = await entryFor(personId);
    expect(newEntry.id).not.toBe(oldEntryId);
    expect(await transitionsFor(oldEntryId)).toEqual(oldTransitions);
    const total = await ctx.db
      .select()
      .from(stageTransitions)
      .where(eq(stageTransitions.personId, personId));
    expect(total).toHaveLength(oldTransitions.length + 1);
  });
});

describe("pipeline data boundaries", () => {
  it("MUST FIRE: the admin board renders a contact name", async () => {
    const personId = fixture.speakerIds[0];
    await postDetail(personId, {
      intent: "enroll-pipeline",
      stage: "prospect",
      score: "73",
      rationale: "Private sourcing rationale",
    });
    const markup = renderToStaticMarkup(<PipelineBoardScreen data={await loadPipeline()} />);
    expect(markup).toContain("Sam Speaker");
  });

  it("MUST NOT FIRE: pipeline score and rationale never reach portal or public wires", async () => {
    const personId = fixture.speakerIds[0];
    const privateRationale = "PRIVATE PIPELINE SCORE 73";
    await postDetail(personId, {
      intent: "enroll-pipeline",
      stage: "in_conversation",
      score: "73",
      rationale: privateRationale,
    });

    const portal = await portalLoader({
      request: await signedInGet("https://x.test/portal", personId),
      params: {},
      context: {},
    } as never);
    const portalJson = JSON.stringify(portal);
    expect(portalJson).not.toContain("rationale");
    expect(portalJson).not.toContain(privateRationale);
    expect(portalJson).not.toContain('"score":73');

    const publicSpeakers = await publicSpeakersLoader({
      request: new Request(`https://x.test/e/${EVENT_SLUG}/speakers`),
      params: { slug: EVENT_SLUG },
      context: {},
    } as never);
    expect(JSON.stringify(publicSpeakers)).not.toContain("pipeline");
  });
});

const LIGHT_COLOR = /^(?:bg|text|border)-(?:white|black|[a-z]+-\d{2,3})$/;
const DARK_COLOR = /^dark:(?:bg|text|border)-(?:white|black|[a-z]+-\d{2,3})$/;

function classNameStrings(source: string): string[] {
  return [...source.matchAll(/className="([^"]*)"/g)].map((match) => match[1]);
}

function classNamesMissingDarkColor(source: string): string[] {
  return classNameStrings(source).filter((className) => {
    const tokens = className.split(/\s+/);
    return tokens.some((token) => LIGHT_COLOR.test(token))
      && !tokens.some((token) => DARK_COLOR.test(token));
  });
}

describe("board render", () => {
  it("MUST FIRE: renders all stage labels, counts, and an empty-column state", async () => {
    await enroll(fixture.speakerIds[0], "prospect");
    const data = await loadPipeline();
    const markup = renderToStaticMarkup(<PipelineBoardScreen data={data} />);

    for (const stage of PIPELINE_STAGES) {
      const marker = `data-testid="pipeline-column-${stage}"`;
      expect(markup).toContain(marker);
      const section = markup.slice(markup.indexOf(marker), markup.indexOf("</section>", markup.indexOf(marker)));
      expect(section).toContain(PIPELINE_STAGE_LABELS[stage]);
      expect(section).toContain(`>${data.columns.find((column) => column.stage === stage)?.cards.length}</span>`);
    }
    expect(markup).toContain("No contacts in this stage.");
  });

  it("MUST FIRE: the hydrated dnd board retains the live e2e card controls", async () => {
    await enroll(fixture.speakerIds[0], "prospect");
    const markup = renderToStaticMarkup(<DndPipelineBoard data={await loadPipeline()} />);

    expect(markup).toContain('data-testid="pipeline-board"');
    expect(markup).toContain('data-testid="pipeline-column-prospect"');
    expect(markup).toContain('data-testid="pipeline-column-contacted"');
    expect(markup).toContain('data-testid="pipeline-column-in_conversation"');
    expect(markup).toContain("<article");
    expect(markup).toContain("Stage for Sam Speaker");
    expect(markup).toContain(">Move</button>");
    expect(markup).toContain(
      'aria-label="Remove Sam Speaker from the sourcing pipeline"',
    );
    expect(markup).toContain('href="/admin/contacts/');
  });

  it("MUST FIRE: every light color className has a dark-mode color", () => {
    const pipelineSources = `${PIPELINE_SOURCE}\n${PIPELINE_BOARD_SOURCE}`;
    const coloredClassNames = classNameStrings(pipelineSources).filter((className) =>
      className.split(/\s+/).some((token) => LIGHT_COLOR.test(token)),
    );
    expect(coloredClassNames.length).toBeGreaterThan(0);
    expect(classNamesMissingDarkColor(pipelineSources)).toEqual([]);
  });

  it("MUST FIRE: moved pipeline-board color classNames keep dark-mode coverage", () => {
    const coloredClassNames = classNameStrings(PIPELINE_BOARD_SOURCE).filter((className) =>
      className.split(/\s+/).some((token) => LIGHT_COLOR.test(token)),
    );
    expect(coloredClassNames.length).toBeGreaterThan(0);
    expect(classNamesMissingDarkColor(PIPELINE_BOARD_SOURCE)).toEqual([]);
  });

  it("MUST FIRE: the dark-mode detector rejects its negative control", () => {
    expect(classNamesMissingDarkColor('<div className="bg-white p-4">')).toHaveLength(1);
    expect(
      classNamesMissingDarkColor('<div className="bg-white p-4 dark:bg-gray-950">'),
    ).toHaveLength(0);
  });
});
