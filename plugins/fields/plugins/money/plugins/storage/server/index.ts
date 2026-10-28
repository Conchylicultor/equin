import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { Fields } from "@plugins/fields/plugins/server-capabilities/server";
import { moneyFieldType } from "@plugins/fields/plugins/money/core";
import { build } from "./internal/storage";

export default {
  portable: true,
  description:
    "Money field type: DB storage capability — maps to a Postgres double precision column.",
  contributions: [Fields.Storage({ type: moneyFieldType, build })],
} satisfies ServerPluginDefinition;
