import { serveCollection } from "@plugins/network/plugins/live/server";
import { Attachments } from "@plugins/infra/plugins/attachments/server";
import { blockAttachmentLinks } from "../../core";
import { blockAttachments } from "./tables";

const blockAttachmentLinksServed = serveCollection(blockAttachmentLinks, {
  from: blockAttachments.table,
});

// Each owner's link set, served for `attachments.by-owner` to follow
// (`Attachments.Link`): the value names no owner, so the owner serves
// and contributes its own set. Spread into the plugin's contributions.
export const attachmentLinkContributions = [
  ...blockAttachmentLinksServed.declare,
  Attachments.Link({
    link: blockAttachments,
    served: blockAttachmentLinksServed,
  }),
];
