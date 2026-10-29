import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";

export { defineTabbedView } from "./internal/define-tabbed-view";
export type {
  TabBadge,
  TabbedHostProps,
  TabbedHostSelection,
  TabbedView,
  TabbedViewOptions,
  TabContribution,
  TabStrip,
} from "./internal/define-tabbed-view";

export default {
  description:
    "Factory for slot-backed tab-host views: per-tab availability gates and count badges, a pill or underline tab strip, and the active tab either device-local (localStorage) or controlled by the caller (a URL param).",
  contributions: [],
} satisfies PluginDefinition;
