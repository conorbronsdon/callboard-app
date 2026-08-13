import { buttonClass, inputClass } from "~/components/portal-ui";
import { linkClass } from "~/components/shell";
import { getDb } from "~/db/client.server";
import {
  PIPELINE_STAGE_LABELS,
  PIPELINE_STAGES,
  type PipelineStage,
} from "~/db/schema";
import { requireAdmin } from "~/lib/auth/auth.server";
import {
  loadBoard,
  moveEntry,
  removeEntry,
  type PipelineBoardCard,
} from "~/lib/pipeline.server";
import type { Route } from "./+types/admin.pipeline";

export interface PipelineBoardData {
  columns: {
    stage: PipelineStage;
    label: string;
    cards: PipelineBoardCard[];
  }[];
}

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
  return (
    <div className="space-y-4" data-testid="pipeline-board">
      <header>
        <h2 className="text-xl font-semibold">Sourcing pipeline</h2>
        <p className="text-sm text-gray-500 dark:text-gray-400">
          Move organization-level contacts through a fixed five-stage workflow.
        </p>
      </header>
      {actionData && "error" in actionData ? (
        <p
          role="alert"
          className="rounded-lg bg-rose-50 p-3 text-sm text-rose-800 dark:bg-rose-950 dark:text-rose-200"
        >
          {actionData.error}
        </p>
      ) : null}
      {actionData && "notice" in actionData ? (
        <p
          role="status"
          className="rounded-lg bg-green-50 p-3 text-sm text-green-800 dark:bg-green-950 dark:text-green-200"
        >
          {actionData.notice}
        </p>
      ) : null}
      <div className="overflow-x-auto pb-2">
        <div className="flex min-w-max gap-4">
          {data.columns.map((column) => (
            <section
              key={column.stage}
              data-testid={`pipeline-column-${column.stage}`}
              className="w-72 shrink-0 rounded-lg border border-gray-200 bg-gray-50 p-3 dark:border-gray-800 dark:bg-gray-900"
            >
              <div className="flex items-center justify-between gap-2">
                <h3 className="font-semibold">{column.label}</h3>
                <span className="rounded-full bg-gray-200 px-2 py-0.5 text-xs dark:bg-gray-800">
                  {column.cards.length}
                </span>
              </div>
              {column.cards.length ? (
                <div className="mt-3 space-y-3">
                  {column.cards.map((card) => (
                    <article
                      key={card.entryId}
                      className="rounded-lg border border-gray-200 bg-white p-3 dark:border-gray-700 dark:bg-gray-950"
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <a className={linkClass} href={`/admin/contacts/${card.personId}`}>
                            {card.fullName}
                          </a>
                          <p className="truncate text-sm text-gray-500 dark:text-gray-400">
                            {card.company ?? "No company"}
                          </p>
                        </div>
                        {card.score !== null ? (
                          <span className="shrink-0 rounded-full bg-blue-100 px-2 py-0.5 text-xs font-medium text-blue-800 dark:bg-blue-950 dark:text-blue-200">
                            {card.score}
                          </span>
                        ) : null}
                      </div>
                      <form method="post" className="mt-3 space-y-2">
                        <input type="hidden" name="entryId" value={card.entryId} />
                        <label className="sr-only" htmlFor={`pipeline-stage-${card.entryId}`}>
                          Stage for {card.fullName}
                        </label>
                        <select
                          id={`pipeline-stage-${card.entryId}`}
                          name="stage"
                          defaultValue={card.stage}
                          className={inputClass}
                        >
                          {data.columns.map((option) => (
                            <option key={option.stage} value={option.stage}>
                              {option.label}
                            </option>
                          ))}
                        </select>
                        <button
                          type="submit"
                          name="intent"
                          value="move"
                          className={buttonClass("secondary", "sm")}
                        >
                          Move
                        </button>
                      </form>
                      <form method="post" className="mt-2">
                        <input type="hidden" name="entryId" value={card.entryId} />
                        <button
                          type="submit"
                          name="intent"
                          value="remove"
                          className={buttonClass("secondary", "sm")}
                          aria-label={`Remove ${card.fullName} from the sourcing pipeline`}
                        >
                          Remove
                        </button>
                      </form>
                    </article>
                  ))}
                </div>
              ) : (
                <p className="mt-3 text-sm text-gray-500 dark:text-gray-400">
                  No contacts here yet.
                </p>
              )}
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}

export default function AdminPipeline({ loaderData, actionData }: Route.ComponentProps) {
  return <PipelineBoardScreen data={loaderData} actionData={actionData} />;
}
