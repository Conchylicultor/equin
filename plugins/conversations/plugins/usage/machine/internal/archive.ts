import { join } from "node:path";
import { z } from "zod";
import { readdir, readFile } from "@plugins/packages/plugins/timed-fs/core";
import { costUsageDir } from "@plugins/infra/plugins/claude-cli/plugins/usage-ledger/plugins/pricing/plugins/price-table/data-dirs";
import { DayBucketSchema } from "../../server/internal/tables";

// ─── What this is ──────────────────────────────────────────────────────────────
//
// A READ-ONLY reader of the legacy permanent cost archive — the year-sharded
// `sessions-<YYYY>.json` files Stats → Cost banked, before the token ledger,
// so the usage of transcripts Claude Code had deleted outlived them. Nothing
// writes these files any more (the token ledger in main's database is the
// archive now); the one-shot history import (`history-import.ts`) is their
// only reader, and they are the only copy of that history until it has run on
// main. So this never writes, renames or deletes a shard, and a shard that
// does not parse THROWS — never an empty archive, which would import nothing
// and record the import as done.

const SHARD_RE = /^sessions-(.+)\.json$/;

const ArchiveEntrySchema = z.object({
  /** The banked token aggregate; only its day buckets are imported. */
  partial: z.object({ dayBuckets: z.array(DayBucketSchema) }),
  /** The title snapshotted at capture (the conversation may be gone since). */
  title: z.string().nullable().catch(null),
  conversationId: z.string().nullable().catch(null),
  /** Whether it was equin's own spend when it was captured (Stats' repo scope). */
  isRepo: z.boolean().catch(false),
});

/** One archived transcript, keyed in the archive map by its full transcript path. */
export type ArchiveEntry = z.infer<typeof ArchiveEntrySchema>;

const ShardSchema = z.record(z.string(), ArchiveEntrySchema);

/**
 * Every archived transcript in `dir` (the host's cost-usage dir by default),
 * keyed by transcript path. An absent dir, or one with no shard, is an empty
 * archive (a host that never ran the old Stats capture); a shard that is not
 * JSON or not `path → entry` throws, naming it.
 */
export async function loadCostArchive(
  dir: string = costUsageDir.path,
): Promise<Map<string, ArchiveEntry>> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    return new Map();
  }
  const out = new Map<string, ArchiveEntry>();
  for (const name of names.filter((n) => SHARD_RE.test(n)).sort()) {
    const path = join(dir, name);
    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(path, "utf8"));
    } catch (err) {
      if (!(err instanceof SyntaxError)) throw err;
      throw new Error(`Corrupt cost archive shard ${path}: ${err.message}`, {
        cause: err,
      });
    }
    const shard = ShardSchema.safeParse(raw);
    if (!shard.success)
      throw new Error(
        `Corrupt cost archive shard ${path}: ${shard.error.message}`,
      );
    for (const [key, entry] of Object.entries(shard.data)) out.set(key, entry);
  }
  return out;
}
