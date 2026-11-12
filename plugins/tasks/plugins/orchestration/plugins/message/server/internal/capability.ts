import { Mandate } from "@plugins/tasks/plugins/orchestration/plugins/mandate/server";
import { messageTree } from "@plugins/tasks/plugins/orchestration/plugins/message/plugins/capability/core";

/** No Mandate line: `list_agents` / `message_agent` appear only when
 * granted, and their descriptions say what a message does. */
export const messageTreeCapability = Mandate.Capability({
  cap: messageTree,
  describe: () => null,
});
