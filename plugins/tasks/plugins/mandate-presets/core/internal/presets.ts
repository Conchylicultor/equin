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
