import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { IdKinds } from "@plugins/ids/server";
import { sessionLinkIdKind } from "../core";

export {
  recordSessionId,
  listSessionChain,
  listSharedClaudeSessionIds,
  listConversationsForSessions,
} from "./internal/record";
export type { SessionChainEntry, SharedSessionId } from "./internal/record";
// The table itself, for a live value's declared reads (a loader that reads the
// chain names this table so a write to it routes a recompute).
export { _conversationSessions } from "./internal/tables";

export default {
  description:
    "Append-only mapping of a conversation to the ordered Claude session ids it has run under. Knows nothing about transcript files.",
  contributions: [IdKinds.Kind({ kind: sessionLinkIdKind })],
} satisfies ServerPluginDefinition;
