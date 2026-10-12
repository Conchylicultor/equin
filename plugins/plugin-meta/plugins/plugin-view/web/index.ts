import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { Pane } from "@plugins/primitives/plugins/pane/web";
import { pluginViewPane } from "./panes";
import { PluginView } from "./slots";

export { pluginViewPane } from "./panes";
export { PluginDetail } from "./components/plugin-detail";
export {
  PluginDetailForId,
  usePluginDisplayName,
} from "./components/plugin-detail-for-id";
export { SectionCount } from "./components/section-count";
export { PluginLink } from "./components/plugin-link";
export { ConsumerList } from "./components/consumer-list";
export { SubHeading } from "./components/sub-heading";
export { PluginView as PluginViewSlots } from "./slots";
export type { PluginNode, PluginTreePayload } from "../core";
export { RUNTIME_COLORS } from "./runtime-colors";
export type { ExportRuntime } from "./runtime-colors";

export default {
  collapsed: true,
  description:
    "Reusable detail pane for inspecting a single plugin. Defines PluginView.Section slot for extensible sections.",
  contributions: [Pane.Register({ pane: pluginViewPane })],
  slots: { ...PluginView, "plugin-view": pluginViewPane },
} satisfies PluginDefinition;
