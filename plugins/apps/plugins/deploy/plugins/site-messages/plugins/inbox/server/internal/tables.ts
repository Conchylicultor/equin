import { _deployDeployments } from "@plugins/apps/plugins/deploy/plugins/deployments/server";
import { defineExtension } from "@plugins/infra/plugins/entity-extensions/server";
import { messagesSeenShape } from "../../shared";

// The user's read mark per site: an entity extension of deployments, owned
// here — the inbox is its only writer and reader, and the row goes with its
// deployment (FK CASCADE). The row is declared once, as `messagesSeenShape`.
export const messagesSeen = defineExtension(
  _deployDeployments,
  "messages_seen",
  messagesSeenShape,
);
// Re-exported so drizzle-kit discovers the underlying pgTable.
export const _deployDeploymentsMessagesSeenExt = messagesSeen.table;
