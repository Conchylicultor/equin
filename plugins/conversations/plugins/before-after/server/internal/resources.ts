import { serveCollection } from "@plugins/network/plugins/live/server";
import { Attachments } from "@plugins/infra/plugins/attachments/server";
import { beforeAfterPairAttachmentLinks, beforeAfterPairs } from "../../core";
import { _beforeAfterPairs } from "./tables";
import { beforeAfterPairAttachments } from "./schema-attachments";

/** `before-after.pairs` over the `before_after_pairs` table: every row field a column. */
export const beforeAfterPairsServed = serveCollection(beforeAfterPairs, {
  from: _beforeAfterPairs,
});

const beforeAfterPairAttachmentLinksServed = serveCollection(
  beforeAfterPairAttachmentLinks,
  { from: beforeAfterPairAttachments.table },
);

/** The pairs' link set, served for `attachments.by-owner` to follow. */
export const beforeAfterAttachmentLinkContributions = [
  ...beforeAfterPairAttachmentLinksServed.declare,
  Attachments.Link({
    link: beforeAfterPairAttachments,
    served: beforeAfterPairAttachmentLinksServed,
  }),
];
