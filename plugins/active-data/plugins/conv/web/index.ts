import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { idChip } from "@plugins/active-data/plugins/id-chip/web";
import { conversationIdKind } from "@plugins/tasks/plugins/task-ids/core";
import { CONV_CHIP_SURFACES } from "../core";
import { ConvChip } from "./components/conv-chip";
import {
  useConversationReferent,
  useConversationTarget,
} from "./internal/presenter";

export { ConvChip };

export default {
  description:
    "Renders raw `conv-<id>` strings inline as clickable chips that open the referenced conversation in the right side pane alongside the host conversation, and presents the conversation id kind (title + open) to the id registry. Models emit the bare id, no tag wrapping needed.",
  contributions: [
    ...idChip({
      presenter: {
        kind: conversationIdKind,
        useReferent: useConversationReferent,
        useTarget: useConversationTarget,
      },
      surfaces: CONV_CHIP_SURFACES,
      component: ConvChip,
    }),
  ],
} satisfies PluginDefinition;
