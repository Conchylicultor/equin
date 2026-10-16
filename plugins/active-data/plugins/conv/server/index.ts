import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { idChipServer } from "@plugins/active-data/plugins/id-chip/server";
import {
  _attempts,
  _conversations,
  _tasks,
} from "@plugins/tasks/plugins/tasks-core/server";
import { conversationIdKind } from "@plugins/tasks/plugins/task-ids/core";
import { CONV_CHIP_SURFACES } from "../core";
import { resolveConversationReferent } from "./internal/referent";

export default {
  description:
    "The conversation id chip's server half (idChipServer): resolves a `conv-<id>` to its conversation's title (else its task's) for the id registry and for model-read text, and registers the page-editor inline token so a page block holding the chip stays agent-readable.",
  contributions: [
    ...idChipServer({
      kind: conversationIdKind,
      tables: [_conversations, _attempts, _tasks],
      surfaces: CONV_CHIP_SURFACES,
      resolve: resolveConversationReferent,
    }),
  ],
} satisfies ServerPluginDefinition;
