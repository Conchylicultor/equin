import { HttpError, implement } from "@plugins/infra/plugins/endpoints/server";
import { answerTriageEndpoint, retriageEndpoint } from "../../shared/endpoints";
import { tasksSidequestTriage } from "./tables";
import { triageJob } from "./triage-jobs";

/** Re-read one sidequest now, whether or not it was read before. */
export const handleRetriage = implement(
  retriageEndpoint,
  async ({ params }) => {
    await triageJob.enqueue({ taskId: params.taskId, force: true });
  },
);

/**
 * The person's answer to triage's question — one of the answers it offered,
 * or `null` to clear it. It approves nothing: approval is the launch list's
 * own click.
 */
export const handleAnswerTriage = implement(
  answerTriageEndpoint,
  async ({ params, body }) => {
    const row = await tasksSidequestTriage.get(params.taskId);
    if (row === undefined) {
      throw new HttpError(404, `Task ${params.taskId} has not been triaged.`);
    }
    if (body.answer !== null && !row.answers.includes(body.answer)) {
      throw new HttpError(
        400,
        `"${body.answer}" is not one of triage's answers (${row.answers.join(", ")}).`,
      );
    }
    const updated = await tasksSidequestTriage.update(params.taskId, {
      answer: body.answer,
    });
    if (updated === undefined) {
      throw new HttpError(404, `Task ${params.taskId} has not been triaged.`);
    }
  },
);
