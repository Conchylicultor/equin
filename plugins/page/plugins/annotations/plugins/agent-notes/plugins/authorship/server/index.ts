import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { BlockLifecycle } from "@plugins/page/plugins/editor/server";
import { agentNotesAuthorsServed } from "./internal/resource";
import { copyAgentAuthorsHook } from "./internal/copy-hook";

export { _pageBlocksAgentAuthors } from "./internal/tables";
export { recordAgentNotesAuthor } from "./internal/mutations";

export default {
  portable: true,
  description:
    "Owns page_blocks_agent_authors: which conversations wrote into an agent-notes card. A race-free (block, conversation) link table, the recordAgentNotesAuthor stamp any writer calls, and the per-card live read behind the card's provenance popover; a copied block keeps its authors.",
  contributions: [
    ...agentNotesAuthorsServed.declare,
    BlockLifecycle.OnCopy(copyAgentAuthorsHook),
  ],
} satisfies ServerPluginDefinition;
