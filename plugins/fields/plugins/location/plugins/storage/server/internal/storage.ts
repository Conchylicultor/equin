import type { z } from "zod";
import { parsedJson } from "@plugins/database/plugins/sql-column/server";
import type { StorageColumnFor } from "@plugins/fields/plugins/server-capabilities/server";
import type { Location } from "@plugins/fields/plugins/location/core";

/** The `jsonb` column holding a location, decoded by the FIELD's own schema. */
export const decode = <V extends Location>(
  name: string,
  valueSchema: z.ZodType<V>,
): StorageColumnFor<V> => parsedJson(name, valueSchema);
