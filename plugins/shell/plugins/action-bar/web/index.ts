import { ActionBar } from "./slots";
import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";

export { ActionBar } from "./slots";
export type { ActionBarContribution } from "./slots";

export default {
  description:
    "Shared cross-app action set. Defines the ActionBar.Item slot that plugins contribute their toolbar actions to, and the ActionBar.ViewOption slot for view options (surface mode, fullscreen, layout editing) folded behind the bar's gear popover; the global-action-bar plugin renders both, gating each contribution by the audience it declares (a developer-audience one shows only in Developer mode). ActionBar.Activity (background work as a ring around the collapsed bar's health dot) and ActionBar.Glance (compact chips beside it) keep that work visible while the floating bar is collapsed.",
  contributions: [],
  slots: ActionBar,
} satisfies PluginDefinition;
