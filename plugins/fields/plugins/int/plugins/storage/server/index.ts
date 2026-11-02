import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { Fields } from "@plugins/fields/plugins/server-capabilities/server";
import { intFieldType } from "@plugins/fields/plugins/int/core";
import { build } from "./internal/storage";

export default {
  description:
    "Integer field type: DB storage capability — maps to a Postgres integer column.",
  contributions: [Fields.Storage({ type: intFieldType, build })],
} satisfies ServerPluginDefinition;
