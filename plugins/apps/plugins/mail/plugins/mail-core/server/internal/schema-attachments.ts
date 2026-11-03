import { Attachments } from "@plugins/infra/plugins/attachments/server";
import { mailDraftAttachmentLinksEntityRef } from "../../core";
import { _mailDrafts } from "./tables";

// Draft ↔ attachment link (FK CASCADE on draft deletion). Kept in its own file
// so the server-only attachments import never leaks into a path reachable from
// `core/` (which web code imports). Included in the drizzle-kit schema glob via
// the `schema*.ts` pattern; the leading `_` on the re-exported pgTable keeps
// cross-plugin imports impossible — only the handle is barrel-exported.
export const mailDraftAttachments = Attachments.defineLink(
  _mailDrafts,
  mailDraftAttachmentLinksEntityRef,
);
export const _mailDraftAttachmentsTable = mailDraftAttachments.table;
