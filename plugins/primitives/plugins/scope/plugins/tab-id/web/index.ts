import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";

export { getTabId } from "./internal/tab-id";
export { useTabPresence, type TabPresence } from "./internal/presence";

export default {
  description:
    "Stable per-tab id (sessionStorage-backed) for crash/notification attribution, and whether the tab an id names is still open (useTabPresence: every page holds a shared Web Lock under its id).",
  contributions: [],
} satisfies PluginDefinition;
