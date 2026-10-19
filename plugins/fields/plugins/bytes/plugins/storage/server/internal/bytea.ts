import { customType } from "drizzle-orm/pg-core";
import { z } from "zod";
import { withWire } from "@plugins/database/plugins/sql-column/server";

// The `bytea` column type. `Uint8Array` on both sides: `pg` returns `Buffer`
// (a `Uint8Array` subclass) and accepts binary params, and Yjs consumes /
// produces plain `Uint8Array` — so no conversion layer. Mirrors the `rankText`
// customType precedent (`primitives/rank/core/internal/types.ts`); `bytea` is a
// single-word dataType, so no PostgreSQL domain indirection is needed.
const byteaType = customType<{ data: Uint8Array; driverData: Uint8Array }>({
  dataType() {
    return "bytea";
  },
});

/**
 * The single JS home for stored bytes → wire base64: the column's wire codec
 * below, and any response that ships stored bytes by hand (editor-collab's
 * doc-init), so the two wire representations are identical by construction.
 * Unfolded — never Postgres' `encode(…, 'base64')`, which breaks lines every
 * 76 chars.
 */
export function bytesToBase64(bytes: Uint8Array): string {
  // Portable (no `Buffer`): binary string in chunks, so a large value never
  // overflows `fromCharCode`'s argument list, then the platform `btoa`.
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

/**
 * A `bytea` column. Its wire form is base64 (declared once here, so every bytea
 * column has it): a row schema projecting one types the field `string`, and
 * `serveCollection` encodes each row's bytes through {@link bytesToBase64}.
 * The `bytes` field type's storage (`bytesField` in an entity record).
 */
export function bytea<TName extends string>(name: TName) {
  return withWire(byteaType(name), {
    schema: z.string(),
    encode: bytesToBase64,
  });
}
