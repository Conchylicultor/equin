import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { Demo } from "@plugins/framework/plugins/browser-server/plugins/demo/web";
import { ConfigV2 } from "./internal/slots";
import { useConfigDemoServe } from "./internal/demo-resource";

export { useConfig, useConfigResult } from "./internal/use-config";
export { useSetConfig } from "./internal/use-set-config";
export { useScopeMembership } from "./internal/use-scope-membership";
export { useConfigRegistrations } from "./internal/use-config-registrations";
export type { ConfigRegistration } from "./internal/use-config-registrations";
export { ConfigV2 } from "./internal/slots";

export default {
  collapsed: true,
  description:
    "Reactive useConfig hook for reading typed JSONC config in the browser.",
  contributions: [
    // Inside a demo scope, every config reads its code defaults.
    Demo.Resource({ id: "config-v2", useServe: useConfigDemoServe }),
  ],
  slots: ConfigV2,
} satisfies PluginDefinition;
