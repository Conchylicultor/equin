import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { conversationSystemPromptServed } from "./internal/compose";

export {
  composeSystemPromptAppend,
  refreshMandateSections,
} from "./internal/compose";
export type { MandateSectionRefresh } from "./internal/compose";
export { _conversationSystemPromptTable } from "./internal/tables";

export default {
  description:
    "Composes what equin appends to an agent's system prompt at a spawn: composeSystemPromptAppend (the preprompt, then every SystemPrompt.Section in id order inside <equin-context id>, a throwing section reported and replaced by a notice), which the launch and resume paths call right before the agent process starts; refreshMandateSections (every section that follows the mandate, rendered again — what it says now, or that one the process carried no longer applies), which the mandate change notice sends a running agent. Records each part's size per conversation (conversations_ext_system_prompt), read by the context card through the lookup-only conversations.system-prompt collection. Apart from the section contribution so a contributor's closure does not carry the conversations table.",
  contributions: [...conversationSystemPromptServed.declare],
} satisfies ServerPluginDefinition;
