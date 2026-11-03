import { Attachments } from "@plugins/infra/plugins/attachments/server";
import { agentAttachmentLinksEntityRef } from "../../core";
import { _agents } from "./tables";

// Agent ↔ attachment link. Agent prompt can carry pasted images via
// `![](/api/attachments/<id>)` markdown refs. Reconciled on update;
// cascade-deleted with the agent row.
export const agentAttachments = Attachments.defineLink(
  _agents,
  agentAttachmentLinksEntityRef,
);
// Re-export the underlying pgTable so drizzle-kit's schema glob picks it up.
export const _agentAttachmentsTable = agentAttachments.table;
