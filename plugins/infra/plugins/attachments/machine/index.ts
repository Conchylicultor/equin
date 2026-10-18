import type { MachinePluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { AttachmentBlobs } from "@plugins/infra/plugins/attachments/server";
import { fileBlobs } from "./internal/file-blobs";

export default {
  description:
    "The desktop's attachment bytes: one UUID-named file per attachment in the host-global `state/attachments` data dir.",
  contributions: [AttachmentBlobs.provide(fileBlobs)],
} satisfies MachinePluginDefinition;
