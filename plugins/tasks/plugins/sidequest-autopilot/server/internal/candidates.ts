import type { LaunchCandidate } from "@plugins/tasks/plugins/automations/server";
import type { SidequestTask } from "@plugins/tasks/plugins/task-track/server";
import {
  compareByTriage,
  latestTriageResult,
  type TriageRead,
  type TriageReadResult,
} from "@plugins/tasks/plugins/task-triage/core";

/** What `{{description}}` says for a task whose title is all there is. */
export const NO_DESCRIPTION = "(No description — the title is the whole task.)";

/** What `{{context}}` says for a sidequest triage has not read. */
export const NO_CONTEXT =
  "(Not triaged — read the task and the code yourself.)";

/** What `{{decision}}` says when the person made no call. */
export const NO_DECISION = "None — nothing was put to the person.";

/** What `{{note}}` says when the person left none. */
export const NO_NOTE = "None — the person left no note.";

/**
 * The ready sidequests as launch candidates, best first — triage's priority
 * (`compareByTriage`: must → should → could → won't, untriaged after, then
 * oldest filed — the launch list's order) — each with its prompt variables.
 * A run in flight or failed ranks by the read it would replace. Which of them
 * may launch is the person's approval, applied by the automations registry,
 * not this order.
 */
export function sidequestCandidates(
  tasks: readonly SidequestTask[],
  triage: ReadonlyMap<string, TriageRead>,
  notes: ReadonlyMap<string, string>,
): LaunchCandidate[] {
  const ranked = tasks
    .map((task) => ({
      task,
      result: latestTriageResult(triage.get(task.id) ?? null),
    }))
    .sort((a, b) =>
      compareByTriage(
        {
          taskId: a.task.id,
          createdAt: a.task.createdAt,
          priority: a.result?.priority ?? null,
        },
        {
          taskId: b.task.id,
          createdAt: b.task.createdAt,
          priority: b.result?.priority ?? null,
        },
      ),
    );
  return ranked.map(({ task, result }) => ({
    taskId: task.id,
    variables: {
      taskId: task.id,
      title: task.title.trim() || "Untitled",
      description: task.description?.trim() || NO_DESCRIPTION,
      context: result?.context.trim() || NO_CONTEXT,
      decision: decisionWords(result),
      note: notes.get(task.id)?.trim() || NO_NOTE,
    },
  }));
}

function decisionWords(result: TriageReadResult | null): string {
  if (result?.question == null || result.answer == null) return NO_DECISION;
  return `Asked: ${result.question}\nThe person answered: ${result.answer}`;
}
