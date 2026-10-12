import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { Fields } from "@plugins/fields/plugins/server-capabilities/server";
import { locationFieldType } from "@plugins/fields/plugins/location/core";
import { decode } from "./internal/storage";

export default {
  description:
    "Location field type: DB storage capability — a Postgres jsonb column, decoded by the field's own schema so a location's shape is derived rather than asserted.",
  contributions: [Fields.Storage({ type: locationFieldType, decode })],
} satisfies ServerPluginDefinition;
