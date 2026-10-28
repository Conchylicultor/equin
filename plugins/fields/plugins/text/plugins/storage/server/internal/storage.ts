import type { z } from "zod";
import { text } from "drizzle-orm/pg-core";
import { parsedText } from "@plugins/database/plugins/sql-column/server";
import type { StorageColumnFor } from "@plugins/fields/plugins/server-capabilities/server";
import {
  inspect,
  isUncheckedBase,
} from "@plugins/packages/plugins/zod-introspect/core";

/**
 * The `text` column, narrowed by whatever the FIELD's own schema says.
 *
 * `enumTextField(...)` is the field-record analogue of `text("x").$type<Union>()`
 * — and `$type` runs nothing, so the union was a claim about rows nobody
 * checked. Handing the schema to `parsedText` makes the claim true: it is what
 * decodes the column, on every read and every write.
 *
 * The branch is on the schema the author actually wrote, not a heuristic about
 * intent — so a plain `textField()` keeps a plain `text` column and pays
 * nothing, which matters because decoding a column that is NOT narrowed costs
 * the same as decoding one that is (345 ns vs 322 ns per value) for zero
 * guarantee. See `research/2026-08-25-global-decoded-entity-columns.md`.
 */
export const decode = <V extends string>(
  name: string,
  valueSchema: z.ZodType<V>,
): StorageColumnFor<V> =>
  isUncheckedBase(valueSchema) && inspect(valueSchema).kind === "string"
    ? // A bare `z.string()` with no checks at all — the column already holds
      // exactly this, so a decoder here would verify nothing at 345 ns/value.
      // A CHECKED string (`.min()`, `.email()`, `.refine()`…) is not bare: it
      // claims something about the rows, so it decodes on every read and write.
      widestTextColumn<V>(name)
    : parsedText(name, valueSchema);

/**
 * The plain `text` column, for the branch where the schema does not narrow it.
 *
 * The cast is SOUND, not a hope: an unchecked base schema accepts every value
 * of its output type and nothing else is added, and for a `z.ZodType<V>` with
 * `V extends string` that base is a bare string schema, whose output type IS
 * `string` — no proper subtype of `string` can come out of one. So `V` is
 * `string` and the plain column holds exactly it. TypeScript cannot narrow a
 * type parameter from a runtime predicate, so the equality is stated here —
 * once, with its proof — rather than at the branch.
 */
const widestTextColumn = <V extends string>(
  name: string,
): StorageColumnFor<V> => text(name) as unknown as StorageColumnFor<V>;
