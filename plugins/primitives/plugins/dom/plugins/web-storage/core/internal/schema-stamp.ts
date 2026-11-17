import type { ZodType } from "zod";
import { hash53 } from "@plugins/packages/plugins/string-hash/core";
import { describeSchema } from "@plugins/packages/plugins/zod-introspect/core";

/**
 * A schema's identity across builds: a hash of zod-introspect's description of
 * it (what it accepts and produces, as data), so two builds whose schema for an
 * owner is the same stamp the same, and any change to what it accepts moves
 * the stamp. A change confined to a transform's body does not (describeSchema
 * cannot see into it).
 *
 * Every stored entry carries the stamp of the schema that wrote it; a store's
 * `migrate` is keyed by it, and kept-state's `work-schema-migrates` check
 * compares it with main's.
 */
export function schemaStamp(schema: ZodType<unknown>): string {
  return hash53(JSON.stringify(describeSchema(schema).description)).toString(
    36,
  );
}
