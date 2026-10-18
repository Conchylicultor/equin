import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { DataViewSlots } from "@plugins/primitives/plugins/data-view/web";
import { boolCodec } from "./internal/codec";

export default {
  description:
    "Boolean field type: data-view custom-column value codec (native boolean ↔ canonical text).",
  contributions: [
    DataViewSlots.ValueCodec({
      match: "bool",
      companion: true,
      codec: boolCodec,
    }),
  ],
} satisfies PluginDefinition;
