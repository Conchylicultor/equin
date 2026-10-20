import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { ConversationArtifacts } from "@plugins/conversations/plugins/conversation-view/plugins/artifacts/web";
import { PAGE_KIND } from "../core";
import { PageSection, PAGE_ICON } from "./components/page-section";

export default {
  description:
    "Singularity pages as a conversation artifact: every page the transcript's edit_page / write_agent_note / read_page calls acted on, listed as a row that opens the page beside the chat — or, for a call scoped to one block of a page, the block view. A write edited the page it wrote into and created every <agent-page> its report says it minted (each its own row), and a read referenced it. Keyed by the page id the apply report names, falling back to the block the call was scoped to; each key resolves through page-tree's useBlockTarget, titled with its page (and, for a block, its type's label).",
  contributions: [
    ConversationArtifacts.Kind({
      id: PAGE_KIND,
      label: "Pages",
      icon: PAGE_ICON,
      Section: PageSection,
    }),
  ],
} satisfies PluginDefinition;
