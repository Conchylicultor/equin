import { parsedJson } from "@plugins/database/plugins/sql-column/server";
import type { StorageColumnFor } from "@plugins/fields/plugins/server-capabilities/server";
import type { ZodParser } from "@plugins/packages/plugins/zod-parser/core";
import type { Location } from "@plugins/fields/plugins/location/core";

/** The `jsonb` column holding a location, decoded by the FIELD's own schema. */
export const decode = <V extends Location>(
  name: string,
  valueSchema: ZodParser<V>,
): StorageColumnFor<V> => parsedJson(name, valueSchema);
