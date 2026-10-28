import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { Fields } from "@plugins/fields/plugins/server-capabilities/server";
import { ordinalFieldType } from "@plugins/fields/plugins/ordinal/core";
import { build } from "./internal/storage";

export default {
  portable: true,
  description:
    "Ordinal field type: DB storage capability — maps to a Postgres integer column.",
  contributions: [Fields.Storage({ type: ordinalFieldType, build })],
} satisfies ServerPluginDefinition;
