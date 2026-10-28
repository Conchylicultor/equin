import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { Fields } from "@plugins/fields/plugins/server-capabilities/server";
import { byteSizeFieldType } from "@plugins/fields/plugins/byte-size/core";
import { build } from "./internal/storage";

export default {
  portable: true,
  description:
    "Byte size field type: DB storage capability — maps to a Postgres double precision column.",
  contributions: [Fields.Storage({ type: byteSizeFieldType, build })],
} satisfies ServerPluginDefinition;
