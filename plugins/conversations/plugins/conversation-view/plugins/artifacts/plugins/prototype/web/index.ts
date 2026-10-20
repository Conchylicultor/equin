import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { ConversationArtifacts } from "@plugins/conversations/plugins/conversation-view/plugins/artifacts/web";
import { PROTOTYPE_KIND } from "../core";
import {
  PrototypeSection,
  PROTOTYPE_ICON,
} from "./components/prototype-section";

export default {
  description:
    "Prototypes as a conversation artifact: every `proto-…` id the transcript names — in a tool input or in the agent's or user's own words — listed as a row that opens the mock beside the chat. A `prototype new` command created what it printed, a Write/Edit inside the folder edited it, anything else referenced it. Titles come from the live prototypes list.",
  contributions: [
    ConversationArtifacts.Kind({
      id: PROTOTYPE_KIND,
      label: "Prototypes",
      icon: PROTOTYPE_ICON,
      Section: PrototypeSection,
    }),
  ],
} satisfies PluginDefinition;
