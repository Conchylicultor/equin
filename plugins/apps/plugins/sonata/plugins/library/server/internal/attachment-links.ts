import { serveCollection } from "@plugins/network/plugins/live/server";
import { Attachments } from "@plugins/infra/plugins/attachments/server";
import { songAttachmentLinks } from "../../core";
import { songAttachments } from "./schema-attachments";

const songAttachmentLinksServed = serveCollection(songAttachmentLinks, {
  from: songAttachments.table,
});

// Each owner's link set, served for `attachments.by-owner` to follow
// (`Attachments.Link`): the value names no owner, so the owner serves
// and contributes its own set. Spread into the plugin's contributions.
export const attachmentLinkContributions = [
  ...songAttachmentLinksServed.declare,
  Attachments.Link({
    link: songAttachments,
    served: songAttachmentLinksServed,
  }),
];
