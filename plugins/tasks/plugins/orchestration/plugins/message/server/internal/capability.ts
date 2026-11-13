import { Mandate } from "@plugins/tasks/plugins/orchestration/plugins/mandate/server";
import { messageTree } from "@plugins/tasks/plugins/orchestration/plugins/message/plugins/capability/core";

/** No Mandate line: `list_agents` appears only when granted, and
 * `message_agent`'s description says who may reopen. */
export const messageTreeCapability = Mandate.Capability({
  cap: messageTree,
  describe: () => null,
});
