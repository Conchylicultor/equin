import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { Fields } from "@plugins/fields/plugins/server-capabilities/server";
import { textFieldType } from "@plugins/fields/plugins/text/core";
import { decode } from "./internal/storage";

export default {
  description:
    "Text field type: DB storage capability — a Postgres text column, decoded by the field's own schema so a narrowed text column (enumTextField) is derived rather than asserted.",
  contributions: [Fields.Storage({ type: textFieldType, decode })],
} satisfies ServerPluginDefinition;
