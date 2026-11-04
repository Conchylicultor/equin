import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { AttachmentBlobs } from "@plugins/infra/plugins/attachments/server";
import { memoryBlobs } from "./internal/memory-blobs";

export default {
  description:
    "Attachment bytes in memory: provides the AttachmentBlobs host service for a host without a filesystem (the browser composition, the portable boot test), written through to the host's declared storage (kept across reloads when it is persistent). Never booted by the desktop.",
  contributions: [AttachmentBlobs.provide(memoryBlobs)],
} satisfies ServerPluginDefinition;
