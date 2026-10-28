import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { DataViewSlots } from "@plugins/primitives/plugins/data-view/web";
import { DurationCell } from "./components/duration-cell";

export default {
  description: "Duration field type: data-view table cell.",
  contributions: [
    DataViewSlots.Cell({
      match: "duration",
      companion: true,
      component: DurationCell,
    }),
  ],
} satisfies PluginDefinition;
