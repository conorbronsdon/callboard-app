import {
  DndPipelineBoard,
  PIPELINE_DROP_FORM_ID,
  PipelineBoard,
  type PipelineBoardData,
} from "~/components/pipeline-board";
import { ClientOnly } from "~/components/ClientOnly";
import { getDb } from "~/db/client.server";
import {
  PIPELINE_STAGE_LABELS,
  PIPELINE_STAGES,
} from "~/db/schema";
import { requireAdmin } from "~/lib/auth/auth.server";
import {
  loadBoard,
  moveEntry,
  removeEntry,
} from "~/lib/pipeline.server";
import type { Route } from "./+types/admin.pipeline";

export type { PipelineBoardData } from "~/components/pipeline-board";

export function meta() {
  return [{ title: "Pipeline — callboard admin" }];
}

export async function loader({ request }: Route.LoaderArgs): Promise<PipelineBoardData> {
  await requireAdmin(request);
  const board = await loadBoard(getDb());
  return {
    columns: PIPELINE_STAGES.map((stage) => ({
      stage,
      label: PIPELINE_STAGE_LABELS[stage],
      cards: board[stage],
    })),
  };
}

export async function action({ request }: Route.ActionArgs) {
  const admin = await requireAdmin(request);
  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "");
  const db = getDb();

  if (intent === "move") {
    const result = await moveEntry(db, {
      entryId: String(formData.get("entryId") ?? ""),
      toStage: formData.get("stage"),
      movedByPersonId: admin.id,
    });
    if (!result.ok) return result;
    const notice = result.moved
      ? `Moved contact to ${PIPELINE_STAGE_LABELS[result.to]}.`
      : "That contact is already in the selected stage.";
    return { ...result, intent, notice };
  }

  if (intent === "remove") {
    const result = await removeEntry(db, {
      entryId: String(formData.get("entryId") ?? ""),
    });
    return {
      ...result,
      intent,
      notice: "Contact removed from the sourcing pipeline. Its transition history was kept.",
    };
  }

  return { ok: false as const, error: `Unknown intent "${intent}".` };
}

type PipelineActionData = Awaited<ReturnType<typeof action>> | undefined;

export function PipelineBoardScreen({
  data,
  actionData,
}: {
  data: PipelineBoardData;
  actionData?: PipelineActionData;
}) {
  return <PipelineBoard data={data} actionData={actionData} />;
}

export default function AdminPipeline({ loaderData, actionData }: Route.ComponentProps) {
  return (
    <>
      <form method="post" id={PIPELINE_DROP_FORM_ID} className="hidden">
        <input type="hidden" name="intent" value="move" />
        <input type="hidden" name="entryId" value="" />
        <input type="hidden" name="stage" value="" />
      </form>
      <ClientOnly fallback={<PipelineBoardScreen data={loaderData} actionData={actionData} />}>
        {() => <DndPipelineBoard data={loaderData} actionData={actionData} />}
      </ClientOnly>
    </>
  );
}
