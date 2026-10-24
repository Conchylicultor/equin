import { HttpError, implement } from "@plugins/infra/plugins/endpoints/server";
import {
  answerTriageEndpoint,
  runTriageEndpoint,
  setTriageNoteEndpoint,
} from "../../core";
import { requestTriage } from "./dispatch";
import { readTriagedTask, setTriageNote } from "./state";
import { tasksTriage } from "./tables";

/** Run or re-run triage of one task, whatever its track or automation. */
export const handleRunTriage = implement(
  runTriageEndpoint,
  async ({ params }) => {
    const outcome = await requestTriage(params.taskId, { force: true });
    if (outcome.kind !== "refused") return outcome;
    switch (outcome.reason) {
      case "no-task":
        throw new HttpError(404, `Task ${params.taskId} does not exist.`);
      case "run-task":
        throw new HttpError(
          400,
          `Task ${params.taskId} is a triage run's own task; it is not triaged.`,
        );
    }
  },
);

/**
 * The person's answer to triage's question — one of the answers it offered,
 * or `null` to clear it. It approves nothing.
 */
export const handleAnswerTriage = implement(
  answerTriageEndpoint,
  async ({ params, body }) => {
    const row = await tasksTriage.get(params.taskId);
    if (row === undefined) {
      throw new HttpError(404, `Task ${params.taskId} has not been triaged.`);
    }
    if (body.answer !== null && !row.answers.includes(body.answer)) {
      throw new HttpError(
        400,
        `"${body.answer}" is not one of triage's answers (${row.answers.join(", ")}).`,
      );
    }
    await tasksTriage.update(params.taskId, { answer: body.answer });
  },
);

/** Set the task's note (blank deletes it). */
export const handleSetTriageNote = implement(
  setTriageNoteEndpoint,
  async ({ params, body }) => {
    if ((await readTriagedTask(params.taskId)) === null) {
      throw new HttpError(404, `Task ${params.taskId} does not exist.`);
    }
    await setTriageNote(params.taskId, body.note);
  },
);
