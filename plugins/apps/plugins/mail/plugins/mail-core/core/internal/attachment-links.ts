import { entityRef } from "@plugins/infra/plugins/entities/core";
import { compositeKey } from "@plugins/network/plugins/live/plugins/query-resource/core";
import { liveCollection } from "@plugins/network/plugins/live/core";
import {
  ATTACHMENT_LINKS_MAX,
  attachmentLinkFields,
} from "@plugins/infra/plugins/attachments/core";

/** The `mail_drafts_attachments` link entity — its table built by `Attachments.defineLink`. */
export const mailDraftAttachmentLinksEntityRef = entityRef(
  "mail_drafts_attachments",
  attachmentLinkFields,
);

/**
 * One mail draft's attachment links, as `attachments.by-owner` follows them for
 * `ownerType: "mail_drafts"` (served and contributed as `Attachments.Link` by this
 * plugin's server): a scoped set by `ownerId` over the table's composite key,
 * in link order. A link written for another owner reaches no reader.
 */
export const mailDraftAttachmentLinks = liveCollection(
  "mail.draft-attachment-links",
  {
    from: mailDraftAttachmentLinksEntityRef,
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
