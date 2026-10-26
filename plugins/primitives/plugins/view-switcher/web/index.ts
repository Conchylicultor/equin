import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";

export {
  ViewSwitcher,
  type ViewSwitcherProps,
  type ViewSwitcherOption,
} from "./components/view-switcher";
export { useActiveViewId } from "./internal/use-active-view";
export type { ActiveViewState } from "./internal/use-active-view";

export default {
  description:
    "Presentational view-switcher chrome: borderless ghost-pill SegmentedControl mapping {id,title,icon} options to a single-select switcher (pure chrome — selection state stays with the caller), plus the opt-in device-local active-id helper useActiveViewId.",
  contributions: [],
} satisfies PluginDefinition;
