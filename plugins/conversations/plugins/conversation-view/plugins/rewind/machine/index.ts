import type { MachinePluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { rewindConversationEndpoint } from "../core/endpoints";
import { handleRewind } from "./internal/handle-rewind";
import { rewindBackupSweepJob } from "./internal/backup-sweep-job";
import { rewindPreviewServed } from "./internal/rewind-preview-served";

export default {
  httpRoutes: {
    [rewindConversationEndpoint.route]: handleRewind,
  },
  register: [rewindBackupSweepJob],
  contributions: [...rewindPreviewServed.declare],
} satisfies MachinePluginDefinition;
