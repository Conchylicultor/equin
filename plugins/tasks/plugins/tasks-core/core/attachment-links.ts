import { entityRef } from "@plugins/infra/plugins/entities/core";
import { compositeKey } from "@plugins/network/plugins/live/plugins/query-resource/core";
import { liveCollection } from "@plugins/network/plugins/live/core";
import {
  ATTACHMENT_LINKS_MAX,
  attachmentLinkFields,
} from "@plugins/infra/plugins/attachments/core";

/** The `tasks_attachments` link entity — its table built by `Attachments.defineLink`. */
export const taskAttachmentLinksEntityRef = entityRef(
  "tasks_attachments",
  attachmentLinkFields,
);

/**
 * One task's attachment links, as `attachments.by-owner` follows them for
 * `ownerType: "tasks"` (served and contributed as `Attachments.Link` by this
 * plugin's server): a scoped set by `ownerId` over the table's composite key,
 * in link order. A link written for another owner reaches no reader.
 */
export const taskAttachmentLinks = liveCollection("tasks.attachment-links", {
  from: taskAttachmentLinksEntityRef,
  carry: { pick: ["ownerId", "attachmentId", "createdAt"] },
  baseExposures: false,
  id: compositeKey(["ownerId", "attachmentId"]),
  all: {
    by: ["ownerId"],
    orderBy: [["createdAt", "asc"]],
    max: ATTACHMENT_LINKS_MAX,
  },
});

/** The `conversations_attachments` link entity — its table built by `Attachments.defineLink`. */
export const conversationAttachmentLinksEntityRef = entityRef(
  "conversations_attachments",
  attachmentLinkFields,
);

/**
 * One conversation's attachment links, as `attachments.by-owner` follows them for
 * `ownerType: "conversations"` (served and contributed as `Attachments.Link` by this
 * plugin's server): a scoped set by `ownerId` over the table's composite key,
 * in link order. A link written for another owner reaches no reader.
 */
export const conversationAttachmentLinks = liveCollection(
  "conversations.attachment-links",
  {
    from: conversationAttachmentLinksEntityRef,
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
