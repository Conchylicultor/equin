import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { CompactionContext } from "@plugins/conversations/plugins/compaction-context/server";
import { restoreAfterCompaction } from "./internal/instructions-gate";
import {
  editPageTool,
  pageInstructionsSection,
  readPageTool,
  writeAgentNoteTool,
} from "./internal/mcp-tools";

export default {
  description:
    "The agent-facing tool surface over a page, as the file triple: read_page (human-audience subtrees pruned), write_agent_note (one agent-authored block's whole contents — an <agent-inline> card, or an <agent-page> by its own id) and edit_page (any block, judged by what the diff touched — every write must resolve inside a region an agent authors, so an <agent-inline> card or an <agent-page> admits it and a <human> or <todo> card nested there refuses it; a tagless <agent-page title> mints a sub-page). The policy over page/markdown-apply's audience-and-author-agnostic engine.",
  contributions: [
    CompactionContext({
      id: "page-instructions",
      restore: (conversationId) => restoreAfterCompaction(conversationId),
    }),
  ],
  register: [
    readPageTool,
    writeAgentNoteTool,
    editPageTool,
    pageInstructionsSection,
  ],
} satisfies ServerPluginDefinition;
