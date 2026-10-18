import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { DataViewSlots } from "@plugins/primitives/plugins/data-view/web";
import { EnumCell } from "./components/enum-cell";

export default {
  description:
    "Enum (select) field type: data-view table cell (read-only chip cell).",
  contributions: [
    DataViewSlots.Cell({
      match: "enum",
      companion: true,
      component: EnumCell,
      // This type presents as a chip, so the list's subtitle run separates it by
      // spacing rather than stringing it on a middot.
      chip: true,
    }),
  ],
} satisfies PluginDefinition;
