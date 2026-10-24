import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";

export { TagPickerPanel } from "./components/tag-picker-panel";
export type { TagPickerPanelProps } from "./components/tag-picker-panel";
export { TagPickerPopover } from "./components/tag-picker-popover";
export type { TagPickerPopoverProps } from "./components/tag-picker-popover";
export { TagPathChip } from "./components/tag-path-chip";
export type { TagPathChipProps } from "./components/tag-path-chip";
export { TagMark } from "./components/tag-mark";
export type { TagMarkProps } from "./components/tag-mark";
export type { TagPickerOptions, TagPickerWrites } from "./internal/types";

export default {
  description:
    "The shared tag picker: TagPickerPanel (pure — search or create a typed path, the foldable tree with rolled-up counts, inline create and rename, a ⋯ menu to recolour, nest out and delete, whole-row drag to reorder and nest), TagPickerPopover wiring it to a declared tree, the TagPathChip header chip and TagMark.",
  contributions: [],
} satisfies PluginDefinition;
