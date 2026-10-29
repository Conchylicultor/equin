import {
  mandatePolicy,
  type MandatePolicy,
} from "@plugins/tasks/plugins/orchestration/plugins/mandate/plugins/policy/core";
import { tasksFile } from "@plugins/tasks/plugins/tasks-core/core";
import {
  exitClean,
  flagRaise,
  pushPolicy,
} from "@plugins/conversations/plugins/conversation-view/plugins/push-and-exit/plugins/capabilities/core";
import { reportRequired } from "@plugins/tasks/plugins/outcome-report/plugins/capability/core";
import {
  watchChildren,
  watchTree,
} from "@plugins/tasks/plugins/orchestration/plugins/watch/plugins/capabilities/core";
import { contextCompact } from "@plugins/conversations/plugins/self-compact/plugins/capability/core";

/**
 * The mandate of a task a person starts by hand (a new conversation, a task
 * filed from the UI, an agent launched from a page): it may file main-track
 * tasks that run after its own and sidequests a person starts, pushes only when
 * the user asks, and talks back through `exit_clean` / `flag_raise`. Exactly the
 * behaviour every agent had before mandates existed.
 */
export function interactiveMandate(): MandatePolicy {
  return mandatePolicy([
    tasksFile.grant({
      main: { start: ["after"] },
      sidequest: { start: ["manual"] },
    }),
    pushPolicy.grant("on-request"),
    exitClean.grant(true),
    flagRaise.grant(true),
  ]);
}

/**
 * The mandate of an autonomous run's root task: its agents start sub-work on
 * their own (main tasks now, after others, or waiting for a person; ideas
 * outside the brief as sidequests a person starts), each ends with a report,
 * watches what it files, and the agent on the root watches the whole tree.
 * They talk back through `flag_raise`; none may close its conversation
 * (`exit.clean` is not granted — a run ends with reports, not exits), and each
 * may compact its own context. No `push.policy`: how a run pushes is the
 * user's to say in the brief or a preprompt, not an instruction of the mode's.
 */
export function autonomousMandate(): MandatePolicy {
  return mandatePolicy([
    tasksFile.grant({
      main: { start: ["now", "after", "manual"] },
      sidequest: { start: ["manual"] },
    }),
    reportRequired.grant(true),
    watchChildren.grant(true),
    watchTree.grant(true),
    flagRaise.grant(true),
    contextCompact.grant(true),
  ]);
}
