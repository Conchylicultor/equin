import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { Fields } from "@plugins/fields/plugins/server-capabilities/server";
import { durationFieldType } from "@plugins/fields/plugins/duration/core";
import { build } from "./internal/storage";

export default {
  portable: true,
  description:
    "Duration field type: DB storage capability — maps to a Postgres double precision column.",
  contributions: [Fields.Storage({ type: durationFieldType, build })],
} satisfies ServerPluginDefinition;
