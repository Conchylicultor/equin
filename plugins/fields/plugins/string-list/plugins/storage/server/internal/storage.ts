import { text } from "drizzle-orm/pg-core";
import type { StorageColumnFor } from "@plugins/fields/plugins/server-capabilities/server";

// A native `text[]`, not jsonb: one array of strings is exactly what the
// column holds, and `= ANY(col)` / `@>` filter it without a JSON path.
export const build = (name: string): StorageColumnFor<string[]> =>
  text(name).array();
