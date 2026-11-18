import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { conversationLaunchesServed } from "./internal/resource";

export {
  abandonLaunch,
  markAgentLaunchPhase,
  markCheckoutBooted,
  markCheckoutEnded,
  openLaunch,
} from "./internal/record";

export default {
  description:
    "One record per agent launch (conversations_ext_launch): from the request to the first streamed token and the first complete message — the spawn job opens it (openLaunch), the worktree.prepare child marks its start, boot, every checkout step and its end (markCheckoutBooted / markCheckoutEnded), and the sdk runtime marks what the agent's events report (markAgentLaunchPhase: started, CLI ready, first token, first message). First-wins marks; served as the conversations.launches window.",
  contributions: [...conversationLaunchesServed.declare],
} satisfies ServerPluginDefinition;
