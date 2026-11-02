import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { Fields } from "@plugins/fields/plugins/server-capabilities/server";
import { uuidFieldType } from "@plugins/fields/plugins/uuid/core";
import { build } from "./internal/storage";

export default {
  description:
    "UUID field type: DB storage capability — maps to a Postgres uuid column.",
  contributions: [Fields.Storage({ type: uuidFieldType, build })],
} satisfies ServerPluginDefinition;
