import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";

export { parsedText } from "./internal/parsed-text";
export { parsedJson } from "./internal/parsed-json";
export { columnSchema } from "./internal/column-schema";
export type { SqlColumnDirection, SqlColumnFailure } from "./internal/errors";
export { formatSqlColumnError } from "./internal/errors";
export { withWire, columnWireCodec } from "./internal/wire";
export type {
  ColumnWire,
  WireBrand,
  WireCodec,
  WithWire,
} from "./internal/wire";

export default {
  description:
    "Decoded columns: `parsedText` / `parsedJson` derive a column's type from a zod schema that really decodes it — on every read and every write — so a column can no longer declare a string-literal union, or a jsonb shape, that nothing verifies. `withWire` declares a column type's JSON wire form (a codec applied in JS by whatever projects the column onto the wire), carried on the built column's type so a row schema must match it.",
} satisfies ServerPluginDefinition;
