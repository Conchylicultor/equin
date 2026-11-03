import { serveCollection } from "@plugins/network/plugins/live/server";
import { Attachments } from "@plugins/infra/plugins/attachments/server";
import { agentAttachmentLinks } from "../../core";
import { agentAttachments } from "./tables-attachments";

const agentAttachmentLinksServed = serveCollection(agentAttachmentLinks, {
  from: agentAttachments.table,
});

// Each owner's link set, served for `attachments.by-owner` to follow
// (`Attachments.Link`): the value names no owner, so the owner serves
// and contributes its own set. Spread into the plugin's contributions.
export const attachmentLinkContributions = [
  ...agentAttachmentLinksServed.declare,
  Attachments.Link({
    link: agentAttachments,
    served: agentAttachmentLinksServed,
  }),
];
