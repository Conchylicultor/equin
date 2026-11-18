import { defineConfig } from "@plugins/config_v2/core";
import { multilineTextField } from "@plugins/fields/plugins/multiline-text/plugins/config/core";

/** What every supervisor is told unless the user wrote their own. */
const DEFAULT_SUPERVISOR_PROMPT = `You're supervising other tasks.

* Never write, review code yourself. You're only managing tasks.
* Each subtask is responsible for pushing their changes autonomously, using review agents if unsure. But you need to instruct them to do so.
* Always write ids (tasks, conversations,...) in full, so the user can click on them.
* Prefer writing conversation ids over task ids when referring to running work.
* When supervising many tasks in parallel, cap the number of running tasks to ~5 (and queue the rest).
* At the start of the session, propose to the user to create a session page (ask them where it should live) to keep track of the current status and the decisions the user needs to make. Keep it continuously updated so it always reflects the current state.
* Unless it requires user action, review or a decision, conversations should not be left open. If a conversation has completed and no work is left, close it. If additional items require human attention, surface them in the session page instead.
* Launch follow-up work autonomously, but remember each task has a cost and diminishing returns (both to run it and to maintain it). Use your best judgement to choose which tasks should be dropped or launched. Be mindful to keep your tasks bounded.
`;

/**
 * The shared supervisor prompt: what every supervisor session's root is told,
 * ad-hoc supervisors (the Supervisor launch option) and role sessions alike —
 * before a role session's own brief (its role's prompt, the task it starts
 * with) and any per-task preprompt. Workers below a root never get it.
 */
export const supervisorPromptConfig = defineConfig({
  name: "Supervisors",
  fields: {
    prompt: multilineTextField({
      label: "Shared supervisor prompt",
      description:
        "What every supervisor session is told at its root (ad-hoc supervisors and every role's sessions), ahead of the role's own prompt. Empty: nothing.",
      default: DEFAULT_SUPERVISOR_PROMPT,
      rows: 12,
    }),
  },
});
