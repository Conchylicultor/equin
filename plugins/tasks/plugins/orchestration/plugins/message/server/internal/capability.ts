import { Mandate } from "@plugins/tasks/plugins/orchestration/plugins/mandate/server";
import { messageTree } from "@plugins/tasks/plugins/orchestration/plugins/message/plugins/capability/core";

export const messageTreeCapability = Mandate.Capability({
  cap: messageTree,
  describe: () =>
    'You may see the agents of this tree with `list_agents` and message one with `message_agent` — a reply to a report, a correction, "push it". A message goes in at once (a working agent reads it at its next step) and resumes an agent that stopped; it answers the way it already reports back.',
});
