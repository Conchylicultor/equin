import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { Fields } from "@plugins/fields/plugins/server-capabilities/server";
import { rankFieldType } from "@plugins/fields/plugins/rank/core";
import { build } from "./internal/storage";

export default {
  description:
    "Rank field type: DB storage capability — maps to the rank_text (C-collation) Postgres domain column.",
  contributions: [Fields.Storage({ type: rankFieldType, build })],
} satisfies ServerPluginDefinition;
