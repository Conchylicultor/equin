import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isSingularityProjectDir } from "./classify-projects";
import type { FilePartial } from "./usage-index";

// ─── What this is ──────────────────────────────────────────────────────────────
//
// The PERMANENT record of token usage, and the reason this plugin's numbers stop
// being retroactively rewritten.
//
// Claude Code deletes transcripts after `cleanupPeriodDays` (default 30) and
// `infra/corpus-index`'s `refreshCorpus` drops vanished paths, so every chart is
// derived from a corpus that silently loses its own past — ~2,000 conversations
// of history are ALREADY unrecoverable on this machine.
//
// That single fact — **there is no source of truth to rebuild this file from** —
// is what makes this module's error handling deliberately unlike every sibling
// cache in the tree:
//
//   • a schema-version mismatch NEVER discards (unlike `loadCorpusFile`, which
//     treats one as empty and rebuilds from disk — safe there, catastrophic
//     here);
//   • a corrupt shard THROWS (unlike the old `loadPricing`, which returned
//     `undefined` on a `SyntaxError` — right for a cache, but here the next
//     flush would overwrite a recoverable file with an empty one);
//   • merge is live-wins-EXCEPT-on-shrink, so an in-place truncation upstream
//     cannot delete tokens we have already banked.
//
// Persistence is year-sharded (`sessions-<YYYY>.json`) and each shard is written
// as a whole-file atomic snapshot (temp + rename), so `sink-safety`'s append rule
// does not apply. `defineFileSink` would be exactly wrong: it ROTATES, and for an
// archive whose entire value is its oldest data, rotation IS the failure mode.

/**
 * Version of the ENTRY shape written by this binary — stamped per entry, never
 * per file, and deliberately NOT `INDEX_VERSION`.
 *
 * Sharing a version with the rebuildable corpus index would mean the next routine
 * reshape of `FilePartial` silently destroyed years of history. Entries carrying
 * an unknown or older version are kept verbatim (see `loadArchive`) and migrated
 * forward in code; for now "migration" is: tolerate, with defaults for anything
 * genuinely absent.
 */
export const ARCHIVE_SCHEMA_VERSION = 1;

/** Shard for entries with no usable `lastActivity` — see `shardKeyFor`. */
export const UNDATED_SHARD_KEY = "undated";

const SHARD_RE = /^sessions-(.+)\.json$/;
const YEAR_RE = /^\d{4}$/;

/** One archived transcript, keyed in the archive map by its full transcript path. */
export interface ArchiveEntry {
  /** The `ARCHIVE_SCHEMA_VERSION` in force when this entry was written. */
  schemaVersion: number;
  /** The banked token aggregate. Pricing-free, so the archive stays re-priceable. */
  partial: FilePartial;
  /**
   * Snapshotted at capture. Titles live in `_conversations` in the per-worktree DB
   * fork and are deleted with their tasks, so a purely live join degrades archived
   * sessions to bare UUIDs. The live join stays the OVERRIDE for rows that survive.
   */
  title: string | null;
  conversationId: string | null;
  /**
   * Snapshotted at capture so the classification survives a repo rename — the live
   * predicate is a match on the encoded project dir against the current repo
   * basename, which stops matching the moment the repo is renamed.
   */
  isSingularity: boolean;
}

/** The live conversation metadata `mergeLive` snapshots, keyed by Claude session id. */
export interface ArchiveConvMeta {
  conversationId: string;
  title: string | null;
}

/**
 * A live partial that carried FEWER tokens than the entry already banked for the
 * same path — i.e. the transcript was truncated in place. The archived value is
 * kept; this record exists so the caller can report the event rather than have a
 * shrink pass silently.
 */
export interface ArchiveShrink {
  path: string;
  sessionId: string;
  archivedTotalTokens: number;
  liveTotalTokens: number;
}

/**
 * `mergeLive`'s result. An auxiliary return rather than a swallowed side effect:
 * `shrunk` is an observation list on a success path (the batch-partial shape), and
 * an empty array genuinely means "nothing shrank".
 */
export interface ArchiveMerge {
  merged: Map<string, ArchiveEntry>;
  shrunk: ArchiveShrink[];
}

/** `flushArchive`'s result — which shards this flush actually rewrote. */
export interface ArchiveFlush {
  /** Absolute paths of the shard files written. Empty when nothing changed. */
  written: string[];
}

// ─── Load ────────────────────────────────────────────────────────────────────

/**
 * Read every `sessions-*.json` shard in `dir` into one map keyed by transcript
 * path.
 *
 * An ABSENT directory (or a directory with no shards) is a legitimate empty
 * success — that is first boot. A shard that exists but does not parse, or whose
 * shape is not `path → entry`, **throws**: continuing would let the next
 * `flushArchive` overwrite a file that a human could still have recovered.
 *
 * Entries are normalized only where a field is genuinely absent or of the wrong
 * type; every other key — including ones written by a FUTURE version of this
 * module — is carried through verbatim by the spread, so a newer binary's fields
 * survive an older binary's load/flush cycle instead of being silently dropped.
 */
export async function loadArchive(dir: string): Promise<Map<string, ArchiveEntry>> {
  const out = new Map<string, ArchiveEntry>();
  for (const name of (await listShardFiles(dir)).sort()) {
    const path = join(dir, name);
    const raw = await readFile(path, "utf8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      if (!(err instanceof SyntaxError)) throw err;
      throw new Error(
        `Corrupt cost archive shard ${path}: ${err.message}. Refusing to continue — ` +
          `flushing over it would destroy unrecoverable history. Restore the file ` +
          `from backup or move it aside deliberately.`,
        { cause: err },
      );
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error(
        `Corrupt cost archive shard ${path}: expected a JSON object of path → entry.`,
      );
    }
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      out.set(key, normalizeEntry(path, key, value));
    }
  }
  return out;
}

function normalizeEntry(shardPath: string, key: string, value: unknown): ArchiveEntry {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Corrupt cost archive shard ${shardPath}: entry ${key} is not an object.`);
  }
  const raw = value as Record<string, unknown>;
  // `partial` is the payload — an entry without one carries nothing and is a
  // corruption, not a version we can tolerate forward.
  const partial = raw["partial"];
  if (typeof partial !== "object" || partial === null || Array.isArray(partial)) {
    throw new Error(
      `Corrupt cost archive shard ${shardPath}: entry ${key} has no usable "partial".`,
    );
  }
  const schemaVersion = raw["schemaVersion"];
  const title = raw["title"];
  const conversationId = raw["conversationId"];
  return {
    // Verbatim first: unknown keys (a future version's) survive the round trip.
    ...raw,
    // `0` = written before this field existed; kept as-is, never bumped on read.
    schemaVersion: typeof schemaVersion === "number" ? schemaVersion : 0,
    partial: partial as FilePartial,
    title: typeof title === "string" ? title : null,
    conversationId: typeof conversationId === "string" ? conversationId : null,
    isSingularity: raw["isSingularity"] === true,
  };
}

// ─── Merge ───────────────────────────────────────────────────────────────────

/**
 * Fold the live corpus into the archive. Pure.
 *
 * - a path in the archive and ABSENT from live **survives untouched** — that is
 *   the whole point of the archive, and the entry keeps its own `schemaVersion`,
 *   its snapshotted `isSingularity`, and any unknown future fields;
 * - a path only in live becomes a new entry stamped at `ARCHIVE_SCHEMA_VERSION`;
 * - a path in both takes the live partial, **unless** the live partial carries
 *   fewer total tokens than the banked one. That is an in-place truncation, so the
 *   archived partial wins and the event is returned in `shrunk`.
 *
 * `metaBySessionId` is keyed by Claude session id (`FilePartial.sessionId`, which
 * is the transcript's basename). It is taken as a plain structural type rather
 * than one of `load-usage.ts`'s types on purpose: `load-usage.ts` imports THIS
 * module, so importing back would close a cycle and drag `db` into every consumer.
 *
 * Fresh non-null metadata wins over the stored snapshot, but a stored non-null
 * `title` is NEVER overwritten by a null — the conversation row being gone is
 * exactly the case the snapshot exists for.
 */
export function mergeLive(
  archive: Map<string, ArchiveEntry>,
  live: Map<string, FilePartial>,
  metaBySessionId: Map<string, ArchiveConvMeta>,
  repoBasename: string,
): ArchiveMerge {
  const merged = new Map(archive);
  const shrunk: ArchiveShrink[] = [];

  for (const [path, partial] of live) {
    const archived = archive.get(path);
    const meta = metaBySessionId.get(partial.sessionId);
    const title = meta?.title ?? archived?.title ?? null;
    const conversationId = meta?.conversationId ?? archived?.conversationId ?? null;
    // Recomputed at capture for paths we can still see; an archive-only entry
    // keeps whatever was true when it was captured (a rename must not retroac-
    // tively unclassify years of history).
    const isSingularity = isSingularityProjectDir(partial.projectDir, repoBasename);

    if (archived && partial.totalTokens < archived.partial.totalTokens) {
      shrunk.push({
        path,
        sessionId: partial.sessionId,
        archivedTotalTokens: archived.partial.totalTokens,
        liveTotalTokens: partial.totalTokens,
      });
      // Keep the banked partial (and its version); still refresh the metadata,
      // which is not what shrank.
      merged.set(path, { ...archived, title, conversationId, isSingularity });
      continue;
    }

    merged.set(path, {
      // Spread first so a future version's unknown sibling fields are preserved
      // even as this binary rewrites the fields it does understand.
      ...archived,
      schemaVersion: ARCHIVE_SCHEMA_VERSION,
      partial,
      title,
      conversationId,
      isSingularity,
    });
  }

  return { merged, shrunk };
}

// ─── Flush ───────────────────────────────────────────────────────────────────

/**
 * Persist `merged` as year shards, writing ONLY the shards whose content changed.
 *
 * Sharding bounds a rewrite to the current year: the archive grows ~25 MB/yr and
 * this runs on the serving process, so a blind full rewrite would be a long
 * synchronous `JSON.stringify` — the same shape that makes `refreshCorpus`'s
 * whole-file rewrite of `index.json` a stall risk. Old shards become immutable in
 * practice, which also makes them cheap to back up.
 *
 * Each shard is serialized with its keys sorted, so the bytes are a pure function
 * of the data (a `Map`-order-dependent serialization would churn every shard on
 * every flush) and the change comparison against the file on disk is meaningful.
 *
 * **Contract:** `merged` must be a superset of `loadArchive(dir)` — i.e. the
 * load → merge → flush cycle. A shard may be rewritten to `{}` when every entry
 * it held moved to another shard (an entry's `lastActivity` crossing a new year),
 * and that is only non-destructive because those entries are still somewhere in
 * `merged`. Do not call this with a partial map.
 */
export async function flushArchive(
  dir: string,
  merged: Map<string, ArchiveEntry>,
): Promise<ArchiveFlush> {
  const byShard = new Map<string, [string, ArchiveEntry][]>();
  for (const [path, entry] of merged) {
    const key = shardKeyFor(entry);
    const rows = byShard.get(key);
    if (rows) rows.push([path, entry]);
    else byShard.set(key, [[path, entry]]);
  }

  // Shards already on disk are candidates too, so a year that emptied out (every
  // entry migrated to the next year) is corrected rather than left holding a
  // stale duplicate that `loadArchive` would resurrect.
  const keys = new Set(byShard.keys());
  for (const name of await listShardFiles(dir)) {
    const key = SHARD_RE.exec(name)?.[1];
    if (key !== undefined) keys.add(key);
  }

  const written: string[] = [];
  for (const key of [...keys].sort()) {
    const rows = (byShard.get(key) ?? []).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    const record: Record<string, ArchiveEntry> = {};
    for (const [path, entry] of rows) record[path] = entry;
    const next = JSON.stringify(record);

    const path = join(dir, `sessions-${key}.json`);
    if ((await readFileOrNull(path)) === next) continue;

    await mkdir(dir, { recursive: true });
    // Atomic whole-file snapshot: a torn write can never be observed, and a
    // crash mid-flush leaves the previous shard intact.
    const tmp = `${path}.${process.pid}.tmp`;
    await writeFile(tmp, next, "utf8");
    await rename(tmp, path);
    written.push(path);
  }

  return { written };
}

/**
 * `YYYY` of the entry's `lastActivity`, or `UNDATED_SHARD_KEY` when it is missing
 * or malformed.
 *
 * Not hypothetical: `parseTranscript` yields `lastActivity: ""` for a transcript
 * whose entries carry no timestamp. A deterministic fallback shard keeps such an
 * entry archived (and re-findable) instead of crashing the flush or dropping it —
 * dropping is the one outcome this module exists to prevent.
 */
function shardKeyFor(entry: ArchiveEntry): string {
  const lastActivity: unknown = entry.partial.lastActivity;
  if (typeof lastActivity !== "string") return UNDATED_SHARD_KEY;
  const year = lastActivity.slice(0, 4);
  return YEAR_RE.test(year) ? year : UNDATED_SHARD_KEY;
}

// ─── fs helpers ──────────────────────────────────────────────────────────────

/** Shard file NAMES in `dir`; an absent directory is first boot, not a failure. */
async function listShardFiles(dir: string): Promise<string[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    return [];
  }
  return names.filter((name) => SHARD_RE.test(name));
}

/** File contents, or `null` for a genuinely absent file. Any other error throws. */
async function readFileOrNull(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    return null;
  }
}
