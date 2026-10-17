import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";

export { PickerPill } from "./components/picker-pill";
export { pillHighlightClass } from "./components/highlight";
export type {
  PickerPillProps,
  PickerPillValueProps,
  PickerPillGroupProps,
  PickerPillItemProps,
  PickerPillCheckProps,
} from "./components/picker-pill";

export default {
  description:
    "Picker pill: a pill-shaped trigger reading `icon value(s) chevron` that opens one grouped menu. Several groups in one pill is the fused control — one trigger, one menu, one heading and one checked row per group.",
  contributions: [],
} satisfies PluginDefinition;
