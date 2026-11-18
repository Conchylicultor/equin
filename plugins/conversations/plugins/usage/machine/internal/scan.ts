import { stat } from "@plugins/packages/plugins/timed-fs/core";
import {
  TOKEN_KINDS,
  TOKEN_TIERS,
  emptyUsageBuckets,
  foldUsageEntry,
  resumeUsageBuckets,
  resumeUsageDelta,
  type DayBucket,
  type SeenEntry,
  type UsageBuckets,
} from "@plugins/infra/plugins/claude-cli/plugins/usage-ledger/core";
import type {
  UsageFileKind,
  UsageTailEntry,
} from "../../server/internal/tables";

// The pure half of the usage sync: advance ONE file's scan state over the bytes
// appended to it, and take the token-ledger delta of its move (`tokenDelta`).
// No database, so the reading and counting rules are tested on their own. No
// pricing: a cost is a read of the ledger (`claude_spend_hours_v`).

/** How many counted entries a file row keeps (see `tailHashes` in `tables.ts`). */
const TAIL_HASHES = 64;
const NEWLINE = 0x0a;
/**
 * How many bytes one read takes: a first read of a transcript (the backfill
 * reads every one on the host, some over 100 MB) holds one chunk and the line
 * it ends inside, never the whole file.
 */
const READ_CHUNK = 8 * 1024 * 1024;
const decoder = new TextDecoder();

/**
 * Fold the complete lines of `path` between `start` (a line start) and `size`
 * into `fold`, a chunk at a time — each parsed line shown to `beforeLine`
 * first, if given. A trailing line with no newline yet is torn
 * (Claude is mid-append) and left for the next read. Returns the offset of the
 * first line not folded, and the hashes of the entries counted, oldest first.
 */
async function foldAppended(
  path: string,
  start: number,
  size: number,
  fold: UsageBuckets,
  beforeLine?: (line: unknown) => void,
): Promise<{ offset: number; hashes: string[] }> {
  const hashes: string[] = [];
  const file = Bun.file(path);
  let offset = start;
  let carry: Uint8Array = new Uint8Array(0);
  for (let at = start; at < size;) {
    const to = Math.min(size, at + READ_CHUNK);
    const read = await file.slice(at, to).bytes();
    at = to;
    const bytes = carry.length === 0 ? read : concat(carry, read);
    const end = bytes.lastIndexOf(NEWLINE);
    if (end < 0) {
      carry = bytes;
      continue;
    }
    for (const raw of decoder.decode(bytes.subarray(0, end)).split("\n")) {
      if (raw === "") continue;
      let line: unknown;
      try {
        line = JSON.parse(raw);
      } catch (err) {
        // A complete line that is not JSON carries no usage this total can
        // count; it is the transcript reader's to report, not this one's.
        if (!(err instanceof SyntaxError)) throw err;
        continue;
      }
      beforeLine?.(line);
      const counted = foldUsageEntry(fold, line);
      if (counted?.kind === "entry" && counted.hash) hashes.push(counted.hash);
    }
    offset += end + 1;
    carry = bytes.subarray(end + 1);
  }
  return { offset, hashes };
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}

/** The tail a scan row keeps: its last counted entries, as the fold now holds them. */
function tailOf(
  hashes: readonly string[],
  fold: UsageBuckets,
): UsageTailEntry[] {
  return hashes.slice(-TAIL_HASHES).map((hash) => {
    const entry = fold.seen.get(hash);
    if (entry === undefined)
      throw new Error(`counted hash ${hash} missing from the fold`);
    return { hash, ...entry };
  });
}

/** One file's scan state, as stored in `conversation_usage_files`. */
export interface FileScan {
  path: string;
  kind: UsageFileKind;
  /** Byte offset of the first line not yet folded — always a line start. */
  offset: number;
  buckets: DayBucket[];
  /** A bare string is a legacy hash (see `tables.ts`); a scan never writes one. */
  tailHashes: (UsageTailEntry | string)[];
}

/**
 * Whether `scan` was counted before a message counted at its largest output:
 * its tail holds bare hashes, and its output is short by every message whose
 * first line was not its last. Such a row is recounted from the start.
 */
export function isLegacyScan(scan: Pick<FileScan, "tailHashes">): boolean {
  return scan.tailHashes.some((entry) => typeof entry === "string");
}

const isTailEntry = (e: UsageTailEntry | string): e is UsageTailEntry =>
  typeof e !== "string";

/** A file's size, or `null` when it does not exist (yet, or any more). */
async function sizeOf(path: string): Promise<number | null> {
  try {
    return (await stat(path)).size;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    return null;
  }
}

/**
 * `prev` advanced over the complete lines `path` now holds — or read from the
 * start when there is no `prev`, when the file shrank (replaced, not appended
 * to), when `prev` is a legacy scan (`isLegacyScan`), or when the caller passes
 * `chainSeen` (a whole-chain re-read: the entries every earlier file of the
 * chain counted). A trailing line with no newline yet is torn (Claude is
 * mid-append) and left for the next read.
 *
 * Returns `prev` itself when nothing was appended, `null` when the file is
 * gone and there is no `prev` to keep. A legacy `prev` whose file is gone
 * cannot be recounted: it keeps its tokens and drops its tail, which only an
 * append would read.
 */
export async function advanceFile(
  path: string,
  kind: UsageFileKind,
  prev: FileScan | undefined,
  chainSeen?: Map<string, SeenEntry>,
): Promise<FileScan | null> {
  const size = await sizeOf(path);
  if (size === null) {
    if (prev !== undefined && isLegacyScan(prev))
      return { ...prev, tailHashes: [] };
    return prev ?? null;
  }
  const restart =
    prev === undefined ||
    size < prev.offset ||
    chainSeen !== undefined ||
    isLegacyScan(prev);
  if (!restart && size === prev.offset) return prev;

  const resumed = restart ? [] : prev.tailHashes.filter(isTailEntry);
  const start = restart ? 0 : prev.offset;
  const fold = restart
    ? { ...emptyUsageBuckets(), ...(chainSeen ? { seen: chainSeen } : {}) }
    : resumeUsageBuckets(
        prev.buckets,
        resumed.map(({ hash, ...entry }) => [hash, entry] as const),
      );
  const read = await foldAppended(path, start, size, fold);
  // Only a torn last line was appended (the writer is mid-line): nothing was
  // read, so the row stays as it is — returning `prev` itself tells the sync
  // there is nothing to write (as `scanTranscript`'s "unchanged" does).
  if (!restart && read.offset === prev.offset) return prev;
  return {
    path,
    kind,
    offset: read.offset,
    buckets: [...fold.buckets.values()],
    // This file's counted hashes, oldest first; the fold's `seen` holds each
    // one's current output (a top-up updates it in place).
    tailHashes: tailOf([...resumed.map((e) => e.hash), ...read.hashes], fold),
  };
}

// ─── The ledger-only scan (every transcript no conversation owns) ─────────────

/**
 * One transcript's scan state as `claude_transcript_scans` holds it: how far
 * it was read, its last counted entries — no buckets, no dollars; what it
 * counted lives in the token ledger, filed as each read's delta — and the
 * claude.ai login in force where it stopped reading (`owner`).
 */
export interface TranscriptScan {
  path: string;
  kind: UsageFileKind;
  /** Byte offset of the first line not yet folded — always a line start. */
  offset: number;
  tailHashes: UsageTailEntry[];
  /**
   * The account uuid of the last `session-owner` record read (see
   * {@link sessionOwnerOf}), or `null` when none was — every entry read
   * since then was spent by it.
   */
  owner: string | null;
  /**
   * Whether `owner` was followed from the transcript's start. A row written
   * before owners were read (`false`) filed its tokens under a guess or
   * under no account; such a source is recounted whole while its files are
   * all on disk (session-sync.ts).
   */
  ownerTracked: boolean;
}

/**
 * Tokens one read counted, split by the claude.ai login that spent them: the
 * login a transcript names in its `session-owner` record (an account uuid),
 * or `null` for entries no record precedes.
 */
export interface OwnedCount {
  owner: string | null;
  buckets: DayBucket[];
}

/**
 * The account uuid a transcript line names as its session's owner, or `null`
 * for any other line. Claude Code (since ~2.1.319) writes
 * `{"type":"session-owner","accountUuid","organizationUuid","sessionId"}` in
 * the metadata block it re-appends through a session (at its start, around
 * every turn, at exit): the claude.ai login (`~/.claude.json`'s
 * `oauthAccount`) the session runs on, kept for the session's life and
 * restored on resume. A new value is written when the session moves to
 * another login. None is written for a session on `CLAUDE_CODE_OAUTH_TOKEN`
 * (an equin added account) or an API key, nor in a sub-agent's transcript.
 */
export function sessionOwnerOf(line: unknown): string | null {
  if (typeof line !== "object" || line === null) return null;
  const record = line as { type?: unknown; accountUuid?: unknown };
  return record.type === "session-owner" &&
    typeof record.accountUuid === "string" &&
    record.accountUuid !== ""
    ? record.accountUuid
    : null;
}

/**
 * What one ledger-only read of a transcript found: nothing new, the file gone
 * (its scan state stays — its tokens are in the ledger for good), the file
 * SHRUNK below what was read (replaced, not appended to: what the ledger holds
 * for it can no longer be told apart, so the caller recounts its whole source),
 * or the read — the new scan state and the buckets it COUNTED (only what this
 * read added, a top-up of an entry counted before included), split by owner.
 */
export type TranscriptRead =
  | { status: "unchanged" | "gone" | "shrunk" }
  | { status: "read"; scan: TranscriptScan; counted: OwnedCount[] };

/**
 * Advance `prev` over the complete lines `path` now holds, or read it from the
 * start when there is no `prev`. Per-file dedup: the entries this file counted
 * before (its tail) and those it counts now, never another file's — the reading
 * Stats → Cost has always applied to every transcript (and ccusage's, near enough).
 *
 * Each entry is counted under the owner of the last `session-owner` record
 * before it (`prev`'s owner at the start, when it tracked one): the count is
 * cut wherever a record names another owner. A top-up of an entry counted
 * before a cut goes to the owner in force when it is read.
 */
export async function scanTranscript(
  path: string,
  kind: UsageFileKind,
  prev: TranscriptScan | undefined,
): Promise<TranscriptRead> {
  const size = await sizeOf(path);
  if (size === null) return { status: "gone" };
  if (prev !== undefined && size < prev.offset) return { status: "shrunk" };
  if (prev !== undefined && size === prev.offset)
    return { status: "unchanged" };
  const resumed = prev?.tailHashes ?? [];
  const fold = resumeUsageDelta(
    resumed.map(({ hash, ...entry }) => [hash, entry] as const),
  );
  let owner = prev?.ownerTracked ? prev.owner : null;
  const counted: OwnedCount[] = [];
  const cut = () => {
    const buckets = tokenDelta(undefined, [...fold.buckets.values()]);
    if (buckets.length > 0) counted.push({ owner, buckets });
    for (const bucket of fold.buckets.values()) zeroTokens(bucket);
  };
  const read = await foldAppended(
    path,
    prev?.offset ?? 0,
    size,
    fold,
    (line) => {
      const next = sessionOwnerOf(line);
      if (next === null || next === owner) return;
      cut();
      owner = next;
    },
  );
  if (prev !== undefined && read.offset === prev.offset)
    return { status: "unchanged" };
  cut();
  return {
    status: "read",
    scan: {
      path,
      kind,
      offset: read.offset,
      tailHashes: tailOf([...resumed.map((e) => e.hash), ...read.hashes], fold),
      owner,
      ownerTracked: prev === undefined || prev.ownerTracked,
    },
    counted,
  };
}

/** `b` with every count set to 0, in place (a fold keeps counting into it). */
function zeroTokens(b: DayBucket): void {
  for (const kind of TOKEN_KINDS) b[kind] = { below: 0, above: 0 };
}

/** A bucket's `(date, model, speed)` — the day it counts toward. */
const dayKey = (b: DayBucket): string => `${b.date}\0${b.model}\0${b.speed}`;
/** A bucket's full key: its day, and its hour (none on a legacy bucket). */
const bucketKey = (b: DayBucket): string => `${dayKey(b)}\0${b.hour ?? ""}`;

type Tokens = Pick<DayBucket, (typeof TOKEN_KINDS)[number]>;

function mapTokens(
  f: (
    kind: (typeof TOKEN_KINDS)[number],
    tier: (typeof TOKEN_TIERS)[number],
  ) => number,
): Tokens {
  const tiered = (kind: (typeof TOKEN_KINDS)[number]) => ({
    below: f(kind, "below"),
    above: f(kind, "above"),
  });
  return {
    input: tiered("input"),
    output: tiered("output"),
    cacheRead: tiered("cacheRead"),
    cacheCreate5m: tiered("cacheCreate5m"),
    cacheCreate1h: tiered("cacheCreate1h"),
  };
}

/**
 * `next`'s buckets minus `prev`'s, per `(date, hour, model, speed)`: the tokens
 * counted since `prev`. Usually only additions; a chain re-read can also take
 * tokens back (a bucket shrinks or goes) — a negative delta, which the ledger
 * adds like any other.
 *
 * A row counted before the fold kept hours holds hourless (day) buckets. An
 * append leaves them as they are (new tokens go to hour buckets beside them);
 * a re-read from the start re-buckets their tokens by hour. Such a day bucket,
 * gone from `next`, is taken out of `next`'s hours of the same day, earliest
 * first — a transcript is append-only, so what was counted before is what came
 * first — and only what is left over (tokens really taken back) stays a
 * negative delta, on the day bucket itself.
 */
function bucketDelta(prev: DayBucket[], next: DayBucket[]): DayBucket[] {
  const before = new Map(prev.map((b) => [bucketKey(b), b]));
  const nextKeys = new Set(next.map(bucketKey));
  const delta: DayBucket[] = next.map((b) => {
    const p = before.get(bucketKey(b));
    return {
      ...b,
      ...mapTokens((kind, tier) => b[kind][tier] - (p?.[kind][tier] ?? 0)),
    };
  });
  const hoursOfDay = new Map<string, DayBucket[]>();
  for (const d of delta) {
    if (d.hour === undefined) continue;
    const day = hoursOfDay.get(dayKey(d)) ?? [];
    day.push(d);
    hoursOfDay.set(dayKey(d), day);
  }
  for (const hours of hoursOfDay.values())
    hours.sort((a, b) => (a.hour ?? 0) - (b.hour ?? 0));
  for (const p of prev) {
    if (nextKeys.has(bucketKey(p))) continue;
    const left: Tokens = mapTokens((kind, tier) => p[kind][tier]);
    if (p.hour === undefined) {
      for (const d of hoursOfDay.get(dayKey(p)) ?? []) {
        for (const kind of TOKEN_KINDS) {
          for (const tier of TOKEN_TIERS) {
            const take = Math.min(left[kind][tier], Math.max(0, d[kind][tier]));
            d[kind][tier] -= take;
            left[kind][tier] -= take;
          }
        }
      }
    }
    delta.push({
      ...p,
      // `0 -`, not `-`: a fully taken-out count stays 0, never -0.
      ...mapTokens((kind, tier) => 0 - left[kind][tier]),
    });
  }
  return delta;
}

/** `b` with every count rounded to a whole token, as the token ledger stores them. */
function rounded(b: DayBucket): DayBucket {
  return { ...b, ...mapTokens((kind, tier) => Math.round(b[kind][tier])) };
}

/**
 * The token-ledger delta of a file row's move from `prev` to `next`
 * (`claude_usage_hours`, the usage-ledger): {@link bucketDelta} over whole
 * tokens — each side rounded first, never the difference, so a row's deltas
 * add up to exactly its rounded buckets however many passes moved it — with
 * the buckets that did not move dropped. Negative where a chain re-read took
 * tokens back.
 */
export function tokenDelta(
  prev: readonly DayBucket[] | undefined,
  next: readonly DayBucket[],
): DayBucket[] {
  return bucketDelta((prev ?? []).map(rounded), next.map(rounded)).filter((d) =>
    TOKEN_KINDS.some((kind) => TOKEN_TIERS.some((tier) => d[kind][tier] !== 0)),
  );
}

/**
 * The ledger hour a bucket's tokens are filed under, as an ISO instant: its
 * UTC hour, or 00:00 of its day for a legacy (hourless) bucket.
 */
export function spendHourKey(b: Pick<DayBucket, "date" | "hour">): string {
  return `${b.date}T${String(b.hour ?? 0).padStart(2, "0")}:00:00.000Z`;
}

/** How many sub-agents a conversation's file rows say it launched (`agent_count`). */
export function agentCountOf(files: Iterable<Pick<FileScan, "kind">>): number {
  let count = 0;
  for (const file of files) if (file.kind === "subagent") count += 1;
  return count;
}
