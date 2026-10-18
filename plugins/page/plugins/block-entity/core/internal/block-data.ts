import { z } from "zod";
import type { ZodParser } from "@plugins/packages/plugins/zod-parser/core";

// A block `data` payload that has been validated against its block type's schema.
// Type-only brand (no runtime shape). The `page_blocks.data` column's type IS
// `BlockData`, so a write that did not pass through `parseBlockData` fails to
// compile. Readers are unaffected: `BlockData` is assignable to the `unknown`
// that `pageData()` / `BlockSchema.data` accept.
//
// Here, beside the entity record, because the record's `data` field decodes
// through `StoredBlockDataSchema` — the column's type is the record's. The
// per-type parse that mints it on writes (`parseBlockData`) stays in page/editor.
//
// String-keyed, as the repo's other cross-plugin brands are (`Namespace`,
// `PluginId`): a `unique symbol` key cannot be named in declaration emit where
// another plugin's inferred type spells it (`PageRowSchema`, TS4023).
export type BlockData = Record<string, unknown> & {
  readonly __brand: "BlockData";
};

/**
 * Mint the {@link BlockData} brand. THE one cast, in one place, with two callers
 * — one per direction across the storage boundary:
 *
 *  - `parseBlockData()` (server) mints it from a **strict parse against the
 *    block type's own schema**, which is what "validated block data" means;
 *  - {@link StoredBlockDataSchema} mints it on the way **out of the column**,
 *    where the brand is re-established by provenance: the column's write type is
 *    `BlockData`, so every row in it came through `parseBlockData` already.
 *
 * A decoder is handed one value and never its row, so it cannot reach the
 * block's `type` and cannot re-run the per-type parse. What it can state is the
 * half of `BlockData` that holds for every block type — the payload is a JSON
 * object — and that half really runs.
 */
export function asBlockData(data: Record<string, unknown>): BlockData {
  return data as BlockData;
}

/**
 * The `page_blocks.data` column's decoder — see {@link asBlockData} for what it
 * does and does not claim.
 *
 * `z.record` rather than a `z.object`: the per-type schemas are contributed by
 * ~35 block-type plugins and a decoder cannot know which one applies, so an
 * object schema here would strip every key it has not heard of — i.e. all of
 * them. `z.record` keeps every key by construction.
 */
export const StoredBlockDataSchema: ZodParser<BlockData> = z
  .record(z.string(), z.unknown())
  .transform(asBlockData);
