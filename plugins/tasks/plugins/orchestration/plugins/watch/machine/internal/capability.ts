import { Mandate } from "@plugins/tasks/plugins/orchestration/plugins/mandate/server";
import {
  watchChildren,
  watchTree,
} from "@plugins/tasks/plugins/orchestration/plugins/watch/plugins/capabilities/core";

// The one Mandate content no tool carries: how the agent paces itself while
// the tasks it filed run.
export const watchChildrenCapability = Mandate.Capability({
  cap: watchChildren,
  describe: () =>
    "What happens under the tasks you file (an agent starting, a report, a question, a flag, a task settling, the subtree going quiet) arrives as an event turn: end your turn while they work, never poll.",
});

export const watchTreeCapability = Mandate.Capability({
  cap: watchTree,
  describe: () =>
    "As the agent on this tree's root task, you also get those events from anywhere in the tree no nearer watcher takes, and the whole tree going quiet.",
});
