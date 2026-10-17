import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { handleUpload } from "./internal/handle-upload";
import { handleGet } from "./internal/handle-get";
import { handleDelete } from "./internal/handle-delete";
import { handleHold } from "./internal/handle-hold";
import { attachmentsByOwnerServed } from "./internal/by-owner";
import { attachmentFileServed } from "./internal/file";
import { orphanSweepJob } from "./internal/orphan-sweep";
import { ensureAttachmentsRoot } from "./internal/paths";
import {
  uploadAttachment,
  getAttachmentFile,
  deleteAttachmentEndpoint,
  holdAttachmentsEndpoint,
} from "../shared/endpoints";

export { _attachments } from "./internal/tables";
export {
  createAttachment,
  deleteAttachment,
  getAttachment,
} from "./internal/operations";
export { Attachments } from "./internal/attachments";
export type { AttachmentLink } from "./internal/define-link";

export default {
  description:
    "Attachments on disk (UUID-named under ~/.singularity/state/attachments/). Consumers declare ownership with Attachments.defineLink(ownerTable); orphan sweep reclaims unreferenced rows past TTL. holdAttachments keeps an attachment an unsent draft references alive for the draft's lifetime.",
  loadBearing: true,
  contributions: [
    ...attachmentsByOwnerServed.declare,
    ...attachmentFileServed.declare,
  ],
  httpRoutes: {
    [uploadAttachment.route]: handleUpload,
    [getAttachmentFile.route]: handleGet,
    [deleteAttachmentEndpoint.route]: handleDelete,
    [holdAttachmentsEndpoint.route]: handleHold,
  },
  // orphanSweepJob declares `schedule` — the jobs worker runs it hourly.
  register: [orphanSweepJob],
  onReady: async () => {
    await ensureAttachmentsRoot();
  },
} satisfies ServerPluginDefinition;
