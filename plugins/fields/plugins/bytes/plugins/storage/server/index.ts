import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { Fields } from "@plugins/fields/plugins/server-capabilities/server";
import { bytesFieldType } from "@plugins/fields/plugins/bytes/core";
import { bytea } from "./internal/bytea";

// The `bytea` column helpers are exported from this lean, drizzle-only barrel:
// schema files (drizzle-kit's sync loader) and the doc-init response import
// them.
export { bytea, bytesToBase64 } from "./internal/bytea";

export default {
  portable: true,
  description:
    "Bytes field type: DB storage capability — a Postgres bytea column whose wire form is unfolded base64 (bytesToBase64, declared once through sql-column's withWire).",
  contributions: [Fields.Storage({ type: bytesFieldType, stored: bytea })],
} satisfies ServerPluginDefinition;
