import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { Fields } from "@plugins/fields/plugins/server-capabilities/server";
import { identifierFieldType } from "@plugins/fields/plugins/identifier/core";
import { build } from "./internal/storage";

export default {
  portable: true,
  description:
    "Identifier field type: DB storage capability — a Postgres text column.",
  contributions: [Fields.Storage({ type: identifierFieldType, build })],
} satisfies ServerPluginDefinition;
