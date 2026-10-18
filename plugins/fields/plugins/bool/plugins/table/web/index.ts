import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { DataViewSlots } from "@plugins/primitives/plugins/data-view/web";
import { BoolCell } from "./components/bool-cell";

export default {
  description:
    "Boolean field type: data-view table cell (read-only check/dash cell).",
  contributions: [
    DataViewSlots.Cell({ match: "bool", companion: true, component: BoolCell }),
  ],
} satisfies PluginDefinition;
