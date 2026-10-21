import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { reorderConfigRegistrations } from "./internal/config-registrations";

// Re-exported for sub-plugins (e.g. reorder/staging) that need the slot registry
// and the per-slot descriptor server-side. Cross-plugin `shared/` imports are
// forbidden (R10); these route through the server barrel instead.
export { reorderDirectiveDescriptor } from "../shared";

export default {
  description:
    "Generic reorder primitive: per-slot config_v2 directives for contribution order/visibility.",
  loadBearing: true,
  // One config_v2 directive descriptor per reorderable slot, registered under
  // the slot's DEFINING plugin (via `pluginId`).
  contributions: reorderConfigRegistrations,
  portable: true,
} satisfies ServerPluginDefinition;
