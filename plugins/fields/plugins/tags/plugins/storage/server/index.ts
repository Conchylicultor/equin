import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { Fields } from "@plugins/fields/plugins/server-capabilities/server";
import { tagsFieldType } from "@plugins/fields/plugins/tags/core";
import { decode } from "./internal/storage";

export default {
  description:
    "Tags field type: DB storage capability — a Postgres jsonb column, decoded by the field's own schema so its string[] is derived rather than asserted.",
  contributions: [Fields.Storage({ type: tagsFieldType, decode })],
} satisfies ServerPluginDefinition;
