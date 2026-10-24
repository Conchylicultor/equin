import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";

export { declaredApps } from "./internal/apps.generated";

export default {
  description:
    "Every app the browser registers, readable on the server: declaredApps — each Apps.App contribution's whole AppRef (id, name, base path, icon, tile colour) and its launch kind (tab or surface mode), generated at build time from the web contributions.",
  portable: true,
} satisfies ServerPluginDefinition;
