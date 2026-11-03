import { Attachments } from "@plugins/infra/plugins/attachments/server";
import { blockAttachmentLinksEntityRef } from "../../core";
import { _blocks } from "@plugins/page/plugins/editor/server";

// The single block ↔ attachment link for ALL page block types (creates
// `page_blocks_attachments`, composite PK, FK cascade both sides). The table
// name is derived from the owner table, so only one plugin may declare it —
// this shared plugin owns it on behalf of every attachment-owning block.
export const blockAttachments = Attachments.defineLink(
  _blocks,
  blockAttachmentLinksEntityRef,
);
// Re-export the underlying pgTable so drizzle-kit's schema glob picks it up.
// The leading `_` and the `internal/` location keep cross-plugin imports
// impossible — only the handle is barrel-exported.
export const _blockAttachmentsTable = blockAttachments.table;
