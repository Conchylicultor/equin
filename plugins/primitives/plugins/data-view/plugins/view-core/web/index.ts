import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { IdKinds } from "@plugins/ids/web";
import { viewIdKind } from "../core";

export { buildInstanceFromRow } from "./internal/resolve-instances";
export type { ResolvedViewInstance } from "./internal/resolve-instances";
export { useViewsConfig } from "./internal/use-views-config";
export type { ViewsConfigHandle } from "./internal/use-views-config";
export { useViewModel } from "./internal/use-view-model";
export type { ViewModelCore, ViewActionsCore } from "./internal/use-view-model";
export { useViewGetter } from "./internal/view-getter";
export type { ViewGetter, AssertStableGetters } from "./internal/view-getter";
export { buildViewDescriptors } from "./internal/build-descriptors";
export { buildViewConfigContributions } from "./internal/config-registrations";
export { EditableViewSwitcher } from "./components/editable-view-switcher";
export { CollapsedViewSwitcher } from "./components/collapsed-view-switcher";
export { AddViewMenuItems } from "./components/add-view-menu-items";
export { ViewSettingsPopover } from "./components/view-settings-popover";

export default {
  description:
    "Type-agnostic named-view-instance engine: instance model + resolver, config-descriptor machinery, debounced write-back, and the editable view-switcher chrome.",
  // Headless engine — registers only the view-instance id kind (`view-…`).
  // Consumers register their own per-id `ConfigV2.WebRegister` via `buildViewConfigContributions`.
  contributions: [IdKinds.Kind({ kind: viewIdKind })],
} satisfies PluginDefinition;
