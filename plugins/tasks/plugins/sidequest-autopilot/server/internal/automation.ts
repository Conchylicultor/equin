import { symbol } from "@plugins/ui/plugins/icons/core";
import { defineAutomation } from "@plugins/tasks/plugins/automations/server";
import { listSidequestTasks } from "@plugins/tasks/plugins/task-track/server";
import {
  sidequestAutopilotConfig,
  SIDEQUEST_AUTOPILOT_ID,
} from "../../shared/config";
import { sidequestCandidates } from "./candidates";
import { triageReadsOf } from "./triage-reads";
import { stopIfPastRunUntil } from "./run-until";

// How many ready sidequests one run reads. The registry keeps only the ones a
// person approved, skips the few already launched or armed, then fills at most
// `concurrency` slots from the rest.
const CANDIDATE_WINDOW = 200;

/**
 * Sidequest autopilot: works through the sidequests the person approved in the
 * background, a few agents at a time. Candidates are the sidequests ready to
 * start — no attempt yet, not held, dropped or blocked (derived status `new`)
 * — best first by triage's value for size; the registry launches only the
 * approved ones, at most `maxLaunches` per turn-on. Each agent gets the autopilot prompt (never ask, check obsolescence
 * first, stay in scope, report with `submit_outcome_report`), and its slot
 * frees when it reports or its task settles. Off by default.
 */
export const sidequestAutopilotAutomation = defineAutomation({
  kind: "launch",
  id: SIDEQUEST_AUTOPILOT_ID,
  label: "Sidequest autopilot",
  icon: symbol("rocket-launch"),
  description:
    "Works through the sidequests you approve: Sonnet reads each one first and proposes it, you approve what may run, and it starts agents on the approved ones, best first, a few at a time up to your cap — each leaves you a report.",
  config: sidequestAutopilotConfig,
  triggers: {
    kinds: ["event"],
    eventLabel: "When a task becomes ready to start",
  },
  inProcess:
    "One indexed read of at most 200 ready sidequests and their triage rows, then at most `concurrency` (≤ 8) origin-row inserts and marker arms — bounded by the window and the slots; a restart leaves the tasks for the next run.",
  promptVariables: [
    { name: "taskId", description: "The sidequest's task id" },
    { name: "title", description: "The sidequest's title" },
    {
      name: "description",
      description: "The sidequest's description (or a note that it has none)",
    },
    {
      name: "context",
      description:
        "What triage wrote about it (or a note that it was not triaged)",
    },
    {
      name: "decision",
      description:
        "Triage's question and the person's answer (or a note that there was none)",
    },
  ],
  candidates: async () => {
    if (await stopIfPastRunUntil()) return [];
    const tasks = await listSidequestTasks({
      statuses: ["new"],
      limit: CANDIDATE_WINDOW,
    });
    return sidequestCandidates(
      tasks,
      await triageReadsOf(tasks.map((t) => t.id)),
    );
  },
});
