import { serveCollection } from "@plugins/network/plugins/live/server";
import { Attachments } from "@plugins/infra/plugins/attachments/server";
import { taskAttachmentLinks, conversationAttachmentLinks } from "../../core";
import { taskAttachments, conversationAttachments } from "./schema-attachments";

const taskAttachmentLinksServed = serveCollection(taskAttachmentLinks, {
  from: taskAttachments.table,
});
const conversationAttachmentLinksServed = serveCollection(
  conversationAttachmentLinks,
  {
    from: conversationAttachments.table,
  },
);

// Each owner's link set, served for `attachments.by-owner` to follow
// (`Attachments.Link`): the value names no owner, so the owner serves
// and contributes its own set. Spread into the plugin's contributions.
export const attachmentLinkContributions = [
  ...taskAttachmentLinksServed.declare,
  Attachments.Link({
    link: taskAttachments,
    served: taskAttachmentLinksServed,
  }),
  ...conversationAttachmentLinksServed.declare,
  Attachments.Link({
    link: conversationAttachments,
    served: conversationAttachmentLinksServed,
  }),
];
