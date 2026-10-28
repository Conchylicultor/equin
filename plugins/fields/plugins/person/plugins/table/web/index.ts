import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { DataViewSlots } from "@plugins/primitives/plugins/data-view/web";
import { PersonCell } from "./components/person-cell";

export default {
  description:
    "Person field type: data-view table cell (a small initial avatar beside the name).",
  contributions: [
    DataViewSlots.Cell({
      match: "person",
      companion: true,
      component: PersonCell,
    }),
  ],
} satisfies PluginDefinition;
