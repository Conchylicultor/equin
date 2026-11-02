import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { Fields } from "@plugins/fields/plugins/server-capabilities/server";
import { boolFieldType } from "@plugins/fields/plugins/bool/core";
import { build } from "./internal/storage";

export default {
  description:
    "Boolean field type: DB storage capability — maps to a Postgres boolean column.",
  contributions: [Fields.Storage({ type: boolFieldType, build })],
} satisfies ServerPluginDefinition;
