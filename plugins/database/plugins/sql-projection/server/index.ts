import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";

export type {
  DecoderOrigin,
  SqlDecoder,
  SqlDecoderLike,
} from "./internal/decoders";
export { decoderOrigin, nullable, parsed, toMapper } from "./internal/decoders";
export { decodedRow } from "./internal/decoded-row";
export type { DecodedRow } from "./internal/decoded-row";
export type { SqlProjectionFailure } from "./internal/errors";
export {
  SqlProjectionError,
  formatSqlProjectionError,
} from "./internal/errors";

export default {
  description:
    "Mapped raw-SQL projections: `parsed` / `nullable` turn a schema or a column into the decoder drizzle's `.mapWith()` derives a projection's type from, so a `sql` expression selected as a value can no longer declare a type nothing produces.",
} satisfies ServerPluginDefinition;
