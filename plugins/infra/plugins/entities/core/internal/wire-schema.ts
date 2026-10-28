import { z } from "zod";
import { fieldsToZodObject } from "@plugins/fields/core";
import type { FieldsRecord } from "@plugins/fields/core";

// Derive the WIRE zod schema for an entity: the strict `z.object` from
// `fieldsToZodObject`, minus the `serverOnly` keys. This is the single helper
// both `defineEntity` (server) and any browser-side consumer call, so
// `entity.schema` (server) and a browser-side `wireSchema(fields, SERVER_ONLY)`
// are EQUAL BY CONSTRUCTION — same inputs, same code path. Browser-safe: it only
// touches `fields/core` + `zod` (no `drizzle-orm`, no `server/`).
//
// `serverOnly = []` (the common case) yields `fieldsToZodObject(fields)`
// verbatim (`.omit({})` is a no-op), so an entity WITHOUT server-only columns is
// entirely unaffected.
export function wireSchema<F extends FieldsRecord, S extends keyof F & string>(
  fields: F,
  serverOnly: readonly S[],
): z.ZodObject<{ [K in Exclude<keyof F, S>]: F[K]["schema"] }> {
  // `.omit`'s mask type (zod's `Exactly<>`) is hostile to the generic `keyof F`
  // shape, so cast the base to the loose `z.ZodObject` first — its
  // mask is a plain `Record<string, true>` — then cast the omitted result back
  // to the precise wire type. `serverOnly = []` ⇒ `.omit({})` is a no-op, so an
  // entity with no server-only columns is byte-identical to `fieldsToZodObject`.
  const mask: Record<string, true> = {};
  for (const k of serverOnly) mask[k] = true;
  const base: z.ZodObject = fieldsToZodObject(fields);
  return base.omit(mask) as unknown as z.ZodObject<{
    [K in Exclude<keyof F, S>]: F[K]["schema"];
  }>;
}
