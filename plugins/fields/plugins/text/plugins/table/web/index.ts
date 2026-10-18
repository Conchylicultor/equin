import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { DataViewSlots } from "@plugins/primitives/plugins/data-view/web";
import { TextCell } from "./components/text-cell";

export default {
  description: "Text field type: data-view table cell (read-only text cell).",
  contributions: [
    DataViewSlots.Cell({ match: "text", companion: true, component: TextCell }),
  ],
} satisfies PluginDefinition;
