import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { DataViewSlots } from "@plugins/primitives/plugins/data-view/web";
import { dateCodec } from "./internal/codec";

export default {
  description:
    "Date field type: data-view custom-column value codec (native Date ↔ canonical ISO text).",
  contributions: [
    DataViewSlots.ValueCodec({
      match: "date",
      companion: true,
      codec: dateCodec,
    }),
  ],
} satisfies PluginDefinition;
