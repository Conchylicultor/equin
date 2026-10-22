import type { MachinePluginDefinition } from "@plugins/framework/plugins/server-core/core";
import {
  previewRewindEndpoint,
  rewindConversationEndpoint,
} from "../core/endpoints";
import { handlePreviewRewind } from "./internal/handle-preview";
import { handleRewind } from "./internal/handle-rewind";
import { rewindBackupSweepJob } from "./internal/backup-sweep-job";

export default {
  httpRoutes: {
    [previewRewindEndpoint.route]: handlePreviewRewind,
    [rewindConversationEndpoint.route]: handleRewind,
  },
  register: [rewindBackupSweepJob],
} satisfies MachinePluginDefinition;
