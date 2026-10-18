import { AppShell } from "./slots";
import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";

export { AppShellLayout, opensPane } from "./components/app-shell-layout";
export type {
  SidebarNavTarget,
  AppShellSidebarItem,
  AppShellSidebarNav,
  AppShellSidebarComponent,
  AppShellToolbarItem,
  AppShellToolbarAction,
  AppShellToolbarComponent,
} from "./components/app-shell-layout";
export { SidebarItem } from "./components/sidebar-nav-item";
export { AppShellBrand } from "./components/app-shell-brand";
export { useBrandDrawnOn } from "./internal/brand-presence";
export { useSidebarDrawnOn } from "./internal/sidebar-presence";
export { SidebarPaneSection } from "./components/sidebar-pane-section";
export { AppShell } from "./slots";
export type {
  FramingContribution,
  BrandContribution,
  AppShellBrandForm,
} from "./slots";
export type { SidebarFramingProps } from "../core";

export default {
  description:
    "Universal app shell: opt-in sidebar + opt-in toolbar chrome wrapping an app-supplied main-area layout renderer (children). With neither slot it collapses to a transparent full-surface host.",
  contributions: [],
  slots: AppShell,
} satisfies PluginDefinition;
