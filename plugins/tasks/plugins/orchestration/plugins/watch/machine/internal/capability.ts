import { Mandate } from "@plugins/tasks/plugins/orchestration/plugins/mandate/server";
import { watchChildren } from "../../core";

export const watchChildrenCapability = Mandate.Capability({
  cap: watchChildren,
  describe: () =>
    "You watch the tasks you file: what happens in their subtrees — an agent starting, a report, a question, a flag, a task settling, the subtree going quiet — arrives as an event turn (several at once are merged into one). You may end your turn while they work; do not poll.",
});
