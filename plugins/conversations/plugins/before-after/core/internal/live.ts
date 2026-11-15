import type { z } from "zod";
import { liveCollection } from "@plugins/network/plugins/live/core";
import { compositeKey } from "@plugins/network/plugins/live/plugins/query-resource/core";
import { ATTACHMENT_LINKS_MAX } from "@plugins/infra/plugins/attachments/core";
import {
  beforeAfterPairAttachmentLinksEntityRef,
  beforeAfterPairsEntityRef,
} from "./entity";

/**
 * Every before / after pair, as a window — newest first. The reads:
 *
 * - one conversation's pairs (the pane's gallery, the Artifacts section):
 *   `useLive(beforeAfterPairs, { where: { conversationId } })`;
 * - the pair a transcript tool call registered:
 *   `useLive(beforeAfterPairs, { where: { toolUseId }, limit: 1 })`;
 * - one pair by id (the pane, the chip): `useLive(beforeAfterPairs, { id })`.
 *
 * Served over `before_after_pairs` (`beforeAfterPairsServed`, `../server`),
 * indexed on (conversation_id, created_at) and on tool_use_id.
 */
export const beforeAfterPairs = liveCollection("before-after.pairs", {
  from: beforeAfterPairsEntityRef,
  pick: ["title", "route", "conversationId", "toolUseId", "createdAt"],
  carry: {
    pick: [
      "id",
      "width",
      "height",
      "colorScheme",
      "beforeAttachmentId",
      "afterAttachmentId",
      "beforeLabel",
      "afterLabel",
    ],
  },
  id: "id",
  sortable: ["createdAt"],
  default: { orderBy: [["createdAt", "desc"]], limit: 50 },
  maxLimit: 200,
});

/**
 * One pair's attachment links (its two PNGs), as `attachments.by-owner`
 * follows them for `ownerType: "before_after_pairs"` — served and contributed
 * as `Attachments.Link` by this plugin's server, so the orphan sweep never
 * reclaims a published image.
 */
export const beforeAfterPairAttachmentLinks = liveCollection(
  "before-after.attachment-links",
  {
    from: beforeAfterPairAttachmentLinksEntityRef,
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

/** One before / after pair, as `beforeAfterPairs` serves it (picked + carried columns). */
export type BeforeAfterPair = z.output<(typeof beforeAfterPairs)["row"]>;
