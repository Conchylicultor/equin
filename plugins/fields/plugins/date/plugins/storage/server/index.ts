import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { Fields } from "@plugins/fields/plugins/server-capabilities/server";
import { dateFieldType } from "@plugins/fields/plugins/date/core";
import { build } from "./internal/storage";

export default {
  description:
    "Date field type: DB storage capability — maps to a Postgres timestamptz column.",
  contributions: [Fields.Storage({ type: dateFieldType, build })],
} satisfies ServerPluginDefinition;
