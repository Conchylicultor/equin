import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { Fields } from "@plugins/fields/plugins/server-capabilities/server";
import { jsonFieldType } from "@plugins/fields/plugins/json/core";
import { decode } from "./internal/storage";

export default {
  description:
    "JSON field type: DB storage capability — a Postgres jsonb column, decoded by the field's own schema so a jsonField<T>'s shape is derived rather than asserted.",
  contributions: [Fields.Storage({ type: jsonFieldType, decode })],
} satisfies ServerPluginDefinition;
