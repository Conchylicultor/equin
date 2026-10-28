import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { Fields } from "@plugins/fields/plugins/server-capabilities/server";
import { personFieldType } from "@plugins/fields/plugins/person/core";
import { build } from "./internal/storage";

export default {
  portable: true,
  description:
    "Person field type: DB storage capability — a Postgres text column.",
  contributions: [Fields.Storage({ type: personFieldType, build })],
} satisfies ServerPluginDefinition;
