import { defineServerContribution } from "@plugins/framework/plugins/server-core/core";
import type { FollowWhereTarget } from "@plugins/network/plugins/live/core";
import type { AttachmentLinkRow } from "../../core";
import { defineLink, type AttachmentLink } from "./define-link";

/**
 * What an owner contributes through `Attachments.Link`: its link handle
 * (`defineLink`, whose `ownerType` it answers by-owner reads for) and the
 * served scoped set over that link's table by `ownerId` — the collection its
 * own `core/` declares (`all: { by: ["ownerId"] }`, composite key).
 */
export interface AttachmentLinkContribution {
  readonly link: AttachmentLink;
  readonly served: FollowWhereTarget<AttachmentLinkRow, "ownerId">;
}

export const Attachments = {
  defineLink,
  /**
   * One owner's link set, for `attachments.by-owner`: the value follows each
   * contributed set (built at `bindDeferredResources`), so it names no owner
   * and a write to one owner's links reaches only that owner's readers.
   * A read for a link `defineLink` registered but nobody contributed fails loudly.
   */
  Link: defineServerContribution<AttachmentLinkContribution>(
    "attachments.link",
    { docLabel: (c) => c.link.ownerType },
  ),
};
