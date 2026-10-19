import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { Fields } from "@plugins/fields/plugins/server-capabilities/server";
import { stringListFieldType } from "@plugins/fields/plugins/string-list/core";
import { build } from "./internal/storage";

export default {
  portable: true,
  description:
    "String-list field type: DB storage capability — maps to a Postgres text[] column.",
  contributions: [Fields.Storage({ type: stringListFieldType, build })],
} satisfies ServerPluginDefinition;
