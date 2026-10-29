import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";

export {
  ToggleChip,
  SegmentedControl,
  type ToggleChipProps,
  type ToggleChipVariant,
  type SegmentedControlProps,
  type SegmentedOption,
  type SegmentedVariant,
} from "./internal/toggle-chip";

export default {
  description:
    "Toggle-chip control: a stateful pill (composes Badge) in one of three colour treatments — solid (filled when on), ghost (accent fill when on, transparent when off) and tinted (accent wash when on, bordered when off) — with active state, button-height matching, polymorphic `as`, plus a SegmentedControl single-select group helper.",
  contributions: [],
} satisfies PluginDefinition;
