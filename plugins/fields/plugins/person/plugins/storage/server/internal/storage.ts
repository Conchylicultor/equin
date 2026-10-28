import { text } from "drizzle-orm/pg-core";
import type { StorageColumnFor } from "@plugins/fields/plugins/server-capabilities/server";

// A plain `text` column: `personField`'s schema is `z.string()`, which does not
// narrow the column, so there is nothing to decode (see text's storage).
export const build = (name: string): StorageColumnFor<string> => text(name);
