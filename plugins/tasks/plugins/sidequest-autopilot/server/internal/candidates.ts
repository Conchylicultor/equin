import type { LaunchCandidate } from "@plugins/tasks/plugins/automations/server";
import type { SidequestTask } from "@plugins/tasks/plugins/task-track/server";
import { triageScore, type SidequestTriage } from "../../shared/triage";

/** What `{{description}}` says for a task whose title is all there is. */
export const NO_DESCRIPTION = "(No description — the title is the whole task.)";

/** What `{{context}}` says for a sidequest triage has not read. */
export const NO_CONTEXT =
  "(Not triaged — read the task and the code yourself.)";

/** What `{{decision}}` says when the person made no call. */
export const NO_DECISION = "None — nothing was put to the person.";

type TriageRead = Pick<
  SidequestTriage,
  "context" | "question" | "answer" | "value" | "sizeMinutes"
>;

/**
 * The ready sidequests as launch candidates, best first — triage's value for
 * size, then (ties, and every untriaged one after the triaged) oldest first,
 * as given — each with its prompt variables. Which of them may launch is the
 * person's approval, applied by the automations registry, not this order.
 */
export function sidequestCandidates(
  tasks: readonly SidequestTask[],
  triage: ReadonlyMap<string, TriageRead>,
): LaunchCandidate[] {
  const ranked = tasks
    .map((task, index) => ({ task, index, read: triage.get(task.id) }))
    .sort(
      (a, b) => triageScore(b.read) - triageScore(a.read) || a.index - b.index,
    );
  return ranked.map(({ task, read }) => ({
    taskId: task.id,
    variables: {
      taskId: task.id,
      title: task.title.trim() || "Untitled",
      description: task.description?.trim() || NO_DESCRIPTION,
      context: read?.context.trim() || NO_CONTEXT,
      decision: decisionWords(read),
    },
  }));
}

function decisionWords(read: TriageRead | undefined): string {
  if (read?.question == null || read.answer == null) return NO_DECISION;
  return `Asked: ${read.question}\nThe person answered: ${read.answer}`;
}
