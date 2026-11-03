import { entityRef } from "@plugins/infra/plugins/entities/core";
import { compositeKey } from "@plugins/infra/plugins/query-resource/core";
import { liveCollection } from "@plugins/network/plugins/live/core";
import {
  ATTACHMENT_LINKS_MAX,
  attachmentLinkFields,
} from "@plugins/infra/plugins/attachments/core";

/** The `page_blocks_attachments` link entity — its table built by `Attachments.defineLink`. */
export const blockAttachmentLinksEntityRef = entityRef(
  "page_blocks_attachments",
  attachmentLinkFields,
);

/**
 * One block's attachment links, as `attachments.by-owner` follows them for
 * `ownerType: "page_blocks"` (served and contributed as `Attachments.Link` by this
 * plugin's server): a scoped set by `ownerId` over the table's composite key,
 * in link order. A link written for another owner reaches no reader.
 */
export const blockAttachmentLinks = liveCollection(
  "page.block-attachment-links",
  {
    from: blockAttachmentLinksEntityRef,
    carry: { pick: ["ownerId", "attachmentId", "createdAt"] },
    baseExposures: false,
    id: compositeKey(["ownerId", "attachmentId"]),
    all: {
      by: ["ownerId"],
      orderBy: [["createdAt", "asc"]],
      max: ATTACHMENT_LINKS_MAX,
    },
  },
);
