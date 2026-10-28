import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { DataViewSlots } from "@plugins/primitives/plugins/data-view/web";
import { MoneyCell } from "./components/money-cell";

export default {
  description: "Money field type: data-view table cell.",
  contributions: [
    DataViewSlots.Cell({
      match: "money",
      companion: true,
      component: MoneyCell,
    }),
  ],
} satisfies PluginDefinition;
