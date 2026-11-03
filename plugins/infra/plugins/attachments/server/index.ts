import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { rawEndpointHandler } from "@plugins/infra/plugins/endpoints/server";
import { handleUpload } from "./internal/handle-upload";
import { handleGet } from "./internal/handle-get";
import { handleDelete } from "./internal/handle-delete";
import { handleHold } from "./internal/handle-hold";
import { attachmentsByOwnerServed } from "./internal/by-owner";
import { attachmentFileServed, attachmentRowsServed } from "./internal/file";
import { attachmentBytesServed } from "./internal/bytes";
import { orphanSweepJob } from "./internal/orphan-sweep";
import { AttachmentBlobs } from "./internal/blobs";
import {
  uploadAttachment,
  deleteAttachmentEndpoint,
  holdAttachmentsEndpoint,
} from "../shared/endpoints";
import { getAttachmentFile } from "../core";

export { _attachments } from "./internal/tables";
export {
  createAttachment,
  deleteAttachment,
  getAttachment,
} from "./internal/operations";
export { Attachments } from "./internal/attachments";
export { AttachmentBlobs } from "./internal/blobs";
export type { AttachmentBlobsImpl } from "./internal/blobs";
export type { AttachmentLink } from "./internal/define-link";
export type { AttachmentLinkContribution } from "./internal/attachments";

export default {
  description:
    "Attachments: rows plus bytes in the host's blob store (AttachmentBlobs — on the desktop UUID-named files under ~/.equin/state/attachments/). Consumers declare ownership with Attachments.defineLink(ownerTable, linkRef) over a link entity their own core declares, serve its scoped link collection and contribute it as Attachments.Link — attachments.by-owner follows each contributed set (built at bind), naming no owner; orphan sweep reclaims unreferenced rows past TTL. holdAttachments keeps an attachment an unsent draft references alive for the draft's lifetime.",
  loadBearing: true,
  contributions: [
    ...attachmentsByOwnerServed.declare,
    ...attachmentFileServed.declare,
    ...attachmentRowsServed.declare,
    ...attachmentBytesServed.declare,
  ],
  httpRoutes: {
    [uploadAttachment.route]: rawEndpointHandler(
      uploadAttachment,
      handleUpload,
    ),
    [getAttachmentFile.route]: handleGet,
    [deleteAttachmentEndpoint.route]: rawEndpointHandler(
      deleteAttachmentEndpoint,
      handleDelete,
    ),
    [holdAttachmentsEndpoint.route]: rawEndpointHandler(
      holdAttachmentsEndpoint,
      handleHold,
    ),
  },
  // orphanSweepJob declares `schedule` — the jobs worker runs it hourly.
  register: [orphanSweepJob],
  onReady: async () => {
    await AttachmentBlobs.get().ensureRoot();
  },
} satisfies ServerPluginDefinition;
