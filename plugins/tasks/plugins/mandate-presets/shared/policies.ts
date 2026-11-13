import {
  mandatePolicy,
  type Grant,
  type MandatePolicy,
} from "@plugins/tasks/plugins/orchestration/plugins/mandate/plugins/policy/core";
import {
  tasksFile,
  tasksManage,
  type TasksFileGrant,
} from "@plugins/tasks/plugins/tasks-core/core";
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
import { messageTree } from "@plugins/tasks/plugins/orchestration/plugins/message/plugins/capability/core";

// What each preset grants — the bodies of their MandateDefinitions (server),
// computed at every resolution. The refs (and what each mandate is for) are
// in core.

/** What `interactiveMandate` (core) grants — its definition's body. */
export function interactivePolicy(): MandatePolicy {
  return mandatePolicy([
    tasksFile.grant({
      main: { start: ["after"] },
      sidequest: { start: ["manual"] },
      backlog: true,
    }),
    pushPolicy.grant("on-request"),
    exitClean.grant("on-request"),
    flagRaise.grant(true),
  ]);
}

/** Grants a mandate built on the supervisor preset adds to it, per scope. */
export interface SupervisorExtraGrants {
  whole?: readonly Grant[];
  root?: readonly Grant[];
  below?: readonly Grant[];
}

/**
 * What `supervisorMandate` (core) grants — its definition's body — plus, for
 * a mandate that inherits it (a supervisor role's), the grants `extra` adds.
 * A capability granted twice (in the preset and in `extra`) throws.
 */
export function supervisorPolicy(
  extra: SupervisorExtraGrants = {},
): MandatePolicy {
  // Granted the root and the workers alike; only what a task filed with no
  // `after` waits on differs.
  const filing: TasksFileGrant = {
    main: { start: ["now", "after", "manual"] },
    sidequest: { start: ["manual"] },
    backlog: true,
  };
  return mandatePolicy(
    [
      watchChildren.grant(true),
      messageTree.grant(true),
      flagRaise.grant(true),
      contextCompact.grant(true),
      ...(extra.whole ?? []),
    ],
    {
      root: [
        // The root stays in progress all session: a task it files waiting on
        // it could never launch while it orchestrates.
        tasksFile.grant({ ...filing, defaultAfter: "none" }),
        pushPolicy.grant("on-request"),
        exitClean.grant("on-request"),
        watchTree.grant(true),
        tasksManage.grant(true),
        ...(extra.root ?? []),
      ],
      below: [
        tasksFile.grant(filing),
        reportRequired.grant(true),
        exitClean.grant("when-done"),
        ...(extra.below ?? []),
      ],
    },
  );
}
