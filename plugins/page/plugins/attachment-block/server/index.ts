import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { Trigger } from "@plugins/infra/plugins/events/server";
import { blocksChanged } from "@plugins/page/plugins/editor/server";
import { reconcileBlockAttachmentsJob } from "./internal/reconcile-job";
import { attachmentLinkContributions } from "./internal/attachment-links";

// Extension point for block plugins whose attachment refs fall outside the flat
// `data.attachmentId` / `data.attachmentIds` convention (e.g. a page's nested
// cover image). The reconcile unions every contributed collector.
export { AttachmentBlock } from "./internal/collectors";
export type { BlockAttachmentCollector } from "./internal/collectors";

export default {
  description:
    "Owns the single block↔attachment link (page_blocks_attachments) and one generic reconcile bound to blocksChanged; FK cascade reclaims on delete.",
  register: [reconcileBlockAttachmentsJob],
  contributions: [
    ...attachmentLinkContributions,
    // Reconcile a page's block↔attachment links whenever its blocks change.
    // Declared (not imperatively bound) so syncTriggerContributions makes it
    // idempotent across reboots. Match-any on pageId — the per-emit pageId
    // reaches the job via the event payload.
    Trigger({ on: blocksChanged, do: reconcileBlockAttachmentsJob, with: {}, oneShot: false }),
  ],
} satisfies ServerPluginDefinition;
