import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";

export { SurfaceCore, TabSurface } from "./components/tab-surface";
export { AppTabsBody } from "./components/app-tabs-body";

export default {
  description:
    "Per-tab surface render core: TabSurface mounts a tab's PaneSurfaceProvider and reports its leaf title; AppTabsBody is the keep-alive fallback body that stacks every open tab. resident={false} unloads a tab: only its pane provider and title reporter stay mounted, and the app mounts again under ScrollRevival.",
} satisfies PluginDefinition;
