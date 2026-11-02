import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { Fields } from "@plugins/fields/plugins/server-capabilities/server";
import { floatFieldType } from "@plugins/fields/plugins/float/core";
import { build } from "./internal/storage";

export default {
  description:
    "Float field type: DB storage capability — maps to a Postgres double precision column.",
  contributions: [Fields.Storage({ type: floatFieldType, build })],
} satisfies ServerPluginDefinition;
