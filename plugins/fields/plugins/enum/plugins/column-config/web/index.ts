import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { DataViewSlots } from "@plugins/primitives/plugins/data-view/web";
import { EnumOptionsEditor } from "./components/enum-options-editor";
import { deriveEnumFieldDef } from "./internal/enum-config";

export default {
  description:
    "Enum field type: data-view custom-column add-time config editor (options add/rename/remove), plus the projection of that config onto the generic FieldDef.options.",
  contributions: [
    DataViewSlots.ColumnConfig({
      match: "enum",
      companion: true,
      component: EnumOptionsEditor,
      derive: deriveEnumFieldDef,
    }),
  ],
} satisfies PluginDefinition;
