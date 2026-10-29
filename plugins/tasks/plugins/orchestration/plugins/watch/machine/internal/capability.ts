import { Mandate } from "@plugins/tasks/plugins/orchestration/plugins/mandate/server";
import {
  watchChildren,
  watchTree,
} from "@plugins/tasks/plugins/orchestration/plugins/watch/plugins/capabilities/core";

export const watchChildrenCapability = Mandate.Capability({
  cap: watchChildren,
  describe: () =>
    "You watch the tasks you file: what happens in their subtrees — an agent starting, a report, a question, a flag, a task settling, the subtree going quiet — arrives as an event turn (several at once are merged into one). You may end your turn while they work; do not poll.",
});

export const watchTreeCapability = Mandate.Capability({
  cap: watchTree,
  describe: () =>
    "The agent running on this tree's root task watches the whole tree: what happens anywhere under it that no nearer watcher takes, and the whole tree going quiet (no agent working, nothing left to start on its own), arrives to it as an event turn.",
});
