import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";

export default {
  description:
    "Web browser app: each tab is a page in a real Chromium on the machine (persistent profile, so logins stick), streamed to a canvas with input sent back.",
  contributions: [],
} satisfies PluginDefinition;
