import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { IdKinds } from "@plugins/ids/server";
import { conversationGroupIdKind } from "../core";

// The conversation-group tables persist user-defined sidebar groupings. The
// interactive Grouped tab has been removed, so the only live consumer is the
// `improve` plugin, which files a pending conversation into a group on launch
// via `addMemberToGroup`. The tables (declared in ./internal/tables) stay so the
// grouping data — and its committed migration — are preserved.
export { addMemberToGroup } from "./internal/repo";

export default {
  description:
    "Conversation-group persistence (tables + addMemberToGroup) backing the improve plugin's group-on-launch. No UI.",
  contributions: [IdKinds.Kind({ kind: conversationGroupIdKind })],
} satisfies ServerPluginDefinition;
