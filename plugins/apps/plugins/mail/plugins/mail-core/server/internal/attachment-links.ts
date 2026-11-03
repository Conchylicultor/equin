import { serveCollection } from "@plugins/network/plugins/live/server";
import { Attachments } from "@plugins/infra/plugins/attachments/server";
import { mailDraftAttachmentLinks } from "../../core";
import { mailDraftAttachments } from "./schema-attachments";

const mailDraftAttachmentLinksServed = serveCollection(
  mailDraftAttachmentLinks,
  {
    from: mailDraftAttachments.table,
  },
);

// Each owner's link set, served for `attachments.by-owner` to follow
// (`Attachments.Link`): the value names no owner, so the owner serves
// and contributes its own set. Spread into the plugin's contributions.
export const attachmentLinkContributions = [
  ...mailDraftAttachmentLinksServed.declare,
  Attachments.Link({
    link: mailDraftAttachments,
    served: mailDraftAttachmentLinksServed,
  }),
];
