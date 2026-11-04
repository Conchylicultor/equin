import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { resizedImagesSweepJob } from "./internal/sweep-job";

export default {
  description:
    "Images on the host filesystem: the daily host-fs-image.sweep keeps the resized-copy cache (machine/'s GET resized) within 30 days unused and 1 GB.",
  register: [resizedImagesSweepJob],
} satisfies ServerPluginDefinition;
