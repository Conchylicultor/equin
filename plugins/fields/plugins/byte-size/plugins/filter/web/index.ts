import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { DataViewSlots } from "@plugins/primitives/plugins/data-view/web";
import { numberOperatorSetWith } from "@plugins/fields/plugins/number/plugins/filter/web";
import { byteSizeOperandUnits } from "./internal/units";

export default {
  description:
    "Byte size field type: data-view filter — number's operators, with operands typed in units.",
  contributions: [
    DataViewSlots.Filter({
      match: "byte-size",
      companion: true,
      ...numberOperatorSetWith(byteSizeOperandUnits),
    }),
  ],
} satisfies PluginDefinition;
