import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";

export { declaredAppPlugins, declaredApps } from "./internal/declared-apps";
export type { DeclaredAppOf } from "./internal/declared-apps";

export default {
  description:
    "Every app the browser registers, readable on the server: declaredApps() — each Apps.App contribution of the plugins the backend's composition loads: whole AppRef (id, name, base path, icon, tile colour) and its launch kind (tab or surface mode), generated at build time from the web contributions; declaredAppPlugins() — the same, each with the web plugin that contributes it.",
} satisfies ServerPluginDefinition;
