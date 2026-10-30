import { defineMandate } from "@plugins/tasks/plugins/orchestration/plugins/mandate/plugins/policy/core";

/**
 * The mandate of a task a person starts by hand (a new conversation, a task
 * filed from the UI, an agent launched from a page): it may file main-track
 * tasks that run after its own and sidequests a person starts, pushes only when
 * the user asks, and talks back through `exit_clean` / `flag_raise`. Exactly the
 * behaviour every agent had before mandates existed.
 */
export const interactiveMandate = defineMandate({
  id: "interactive",
  label: "Interactive",
});

/**
 * The mandate of a supervisor's root task. The conversation on the root is an
 * ordinary interactive one (it pushes when the user asks, may close with
 * `exit_clean`, owes no report) with more powers: it may start sub-work on its
 * own (main tasks now, after others, or waiting for a person; ideas outside
 * the brief as sidequests a person starts), watches what it files and the
 * whole tree, messages the agents of the tree (a reply to a report, "push
 * it") and may compact its own context. The tasks below it are workers:
 * each ends with a report (`report.required`), then closes itself with
 * `exit_clean` (`exit.clean: when-done` — the supervisor's message resumes
 * it), watches what it files, may message the tree's agents, talks back through `flag_raise`
 * and may compact. Workers get no
 * `push.policy`: they follow the repo rule (never push unless told) — how a run
 * pushes is the user's to say in the brief or a preprompt.
 */
export const supervisorMandate = defineMandate({
  id: "supervisor",
  label: "Supervisor",
});
