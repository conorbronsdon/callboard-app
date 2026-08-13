import { asc, desc, eq, isNull, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";

import type { DB } from "~/db/client.server";
import {
  people,
  pipelineEntries,
  PIPELINE_STAGES,
  stageTransitions,
  type PipelineStage,
} from "~/db/schema";

type ScoreResult = { ok: true; score: number | null } | { ok: false; error: string };

function normalizeScore(value: unknown): ScoreResult {
  if (value === null || value === undefined || value === "") {
    return { ok: true, score: null };
  }
  const score = typeof value === "string" && value.trim() ? Number(value) : value;
  if (typeof score !== "number" || !Number.isInteger(score) || score < 0 || score > 100) {
    return { ok: false, error: "Score must be a whole number from 0 to 100." };
  }
  return { ok: true, score };
}

function normalizeRationale(value: unknown): string | null {
  const rationale = String(value ?? "").trim().slice(0, 1000);
  return rationale || null;
}

async function nextPosition(db: DB, stage: PipelineStage): Promise<number> {
  const rows = await db
    .select({ position: sql<number>`coalesce(max(${pipelineEntries.position}), -1)` })
    .from(pipelineEntries)
    .where(eq(pipelineEntries.stage, stage));
  return (rows[0]?.position ?? -1) + 1;
}

export function isPipelineStage(value: unknown): value is PipelineStage {
  return typeof value === "string" && PIPELINE_STAGES.includes(value as PipelineStage);
}

export async function enrollContact(
  db: DB,
  {
    personId,
    stage = "prospect",
    score = null,
    rationale = null,
    movedByPersonId = null,
  }: {
    personId: string;
    stage?: unknown;
    score?: unknown;
    rationale?: unknown;
    movedByPersonId?: string | null;
  },
) {
  if (!isPipelineStage(stage)) {
    return { ok: false as const, error: "Choose a valid sourcing stage." };
  }
  const parsedScore = normalizeScore(score);
  if (!parsedScore.ok) return parsedScore;

  const person = await db.query.people.findFirst({ where: eq(people.id, personId) });
  if (!person) return { ok: false as const, error: "That contact does not exist." };
  if (person.mergedInto) {
    return { ok: false as const, error: "This contact was merged into another record." };
  }

  const existing = await db.query.pipelineEntries.findFirst({
    where: eq(pipelineEntries.personId, personId),
  });
  const name = person.fullName ?? person.email;
  if (existing) {
    return { ok: false as const, error: `${name} is already in the sourcing pipeline.` };
  }

  const entryId = crypto.randomUUID();
  const position = await nextPosition(db, stage);
  try {
    await db.batch([
      db.insert(pipelineEntries).values({
        id: entryId,
        personId,
        stage,
        position,
        score: parsedScore.score,
        rationale: normalizeRationale(rationale),
      }),
      db.insert(stageTransitions).values({
        entryId,
        personId,
        fromStage: null,
        toStage: stage,
        movedByPersonId,
      }),
    ]);
  } catch {
    const enrolled = await db.query.pipelineEntries.findFirst({
      where: eq(pipelineEntries.personId, personId),
    });
    return enrolled
      ? { ok: false as const, error: `${name} is already in the sourcing pipeline.` }
      : { ok: false as const, error: "The contact could not be added to the sourcing pipeline." };
  }
  return { ok: true as const, entryId };
}

export async function moveEntry(
  db: DB,
  {
    entryId,
    toStage,
    movedByPersonId = null,
  }: { entryId: string; toStage: unknown; movedByPersonId?: string | null },
) {
  if (!isPipelineStage(toStage)) {
    return { ok: false as const, error: "Choose a valid sourcing stage." };
  }
  const entry = await db.query.pipelineEntries.findFirst({
    where: eq(pipelineEntries.id, entryId),
  });
  if (!entry) return { ok: false as const, error: "That pipeline entry does not exist." };
  if (entry.stage === toStage) return { ok: true as const, moved: false as const };

  const position = await nextPosition(db, toStage);
  await db.batch([
    db
      .update(pipelineEntries)
      .set({ stage: toStage, position })
      .where(eq(pipelineEntries.id, entryId)),
    db.insert(stageTransitions).values({
      entryId,
      personId: entry.personId,
      fromStage: entry.stage,
      toStage,
      movedByPersonId,
    }),
  ]);
  return {
    ok: true as const,
    moved: true as const,
    from: entry.stage,
    to: toStage,
  };
}

export async function removeEntry(db: DB, { entryId }: { entryId: string }) {
  await db.delete(pipelineEntries).where(eq(pipelineEntries.id, entryId));
  return { ok: true as const };
}

export interface PipelineBoardCard {
  entryId: string;
  personId: string;
  fullName: string;
  email: string;
  company: string | null;
  stage: PipelineStage;
  score: number | null;
  position: number;
}

export async function loadBoard(db: DB): Promise<Record<PipelineStage, PipelineBoardCard[]>> {
  const rows = await db
    .select({
      entryId: pipelineEntries.id,
      personId: people.id,
      fullName: people.fullName,
      email: people.email,
      company: people.company,
      stage: pipelineEntries.stage,
      score: pipelineEntries.score,
      position: pipelineEntries.position,
    })
    .from(pipelineEntries)
    .innerJoin(people, eq(people.id, pipelineEntries.personId))
    .where(isNull(people.mergedInto))
    .orderBy(asc(pipelineEntries.position), asc(pipelineEntries.enrolledAt));

  const board: Record<PipelineStage, PipelineBoardCard[]> = {
    prospect: [],
    contacted: [],
    in_conversation: [],
    confirmed: [],
    declined: [],
  };
  for (const row of rows) {
    board[row.stage].push({ ...row, fullName: row.fullName ?? row.email });
  }
  return board;
}

export async function loadPipelineForPerson(db: DB, personId: string) {
  const mover = alias(people, "pipeline_mover");
  const [entryRows, transitionRows] = await Promise.all([
    db
      .select({
        entryId: pipelineEntries.id,
        stage: pipelineEntries.stage,
        position: pipelineEntries.position,
        score: pipelineEntries.score,
        rationale: pipelineEntries.rationale,
        enrolledAt: pipelineEntries.enrolledAt,
      })
      .from(pipelineEntries)
      .where(eq(pipelineEntries.personId, personId))
      .limit(1),
    db
      .select({
        id: stageTransitions.id,
        fromStage: stageTransitions.fromStage,
        toStage: stageTransitions.toStage,
        byName: mover.fullName,
        byEmail: mover.email,
        createdAt: stageTransitions.createdAt,
      })
      .from(stageTransitions)
      .leftJoin(mover, eq(mover.id, stageTransitions.movedByPersonId))
      .where(eq(stageTransitions.personId, personId))
      .orderBy(desc(stageTransitions.createdAt)),
  ]);

  return {
    entry: entryRows[0] ?? null,
    transitions: transitionRows.map(({ byEmail, ...row }) => ({
      ...row,
      byName: row.byName ?? byEmail ?? "Deleted organizer",
    })),
  };
}
