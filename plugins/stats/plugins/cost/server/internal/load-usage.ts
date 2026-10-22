import { isNotNull } from "drizzle-orm";
import { db } from "@plugins/database/server";
import { _conversations } from "@plugins/tasks/plugins/tasks-core/server";
import {
  CLAUDE_PROJECTS_DIR,
  isHostSingleton,
} from "@plugins/infra/plugins/paths/server";
import { costUsageDir } from "../../data-dirs";
import { ensureMainWorktreeRoot } from "@plugins/infra/plugins/worktree/server";
import { defineCorpusIndex } from "@plugins/infra/plugins/corpus-index/server";
import { defineWarmup } from "@plugins/infra/plugins/warmup/server";
import { acquireDirWatch } from "@plugins/infra/plugins/file-watcher/server";
import { modelIdFromCliName } from "@plugins/conversations/plugins/model-provider/core";
import {
  flushArchive,
  loadArchive,
  mergeLive,
  type ArchiveConvMeta,
  type ArchiveEntry,
  type ArchiveShrink,
} from "./archive";
import { isSingularityProjectDir } from "./classify-projects";
import { loadFallbackPriceTable } from "./litellm-fallback";
import {
  fetchPriceTable,
  loadPriceTable,
  mergePriceTable,
  savePriceTable,
} from "./price-table";
import type { PriceTable } from "../../core";
import { reportCostAnomalies } from "./record-anomalies";
import {
  INDEX_VERSION,
  parseTranscript,
  rollup,
  type DailyRow,
  type FilePartial,
  type SessionRollup,
  type UnpricedModel,
} from "./usage-index";

export type { DailyRow } from "./usage-index";

/**
 * The conversation a session ran, as the ARCHIVE snapshotted it at capture
 * (`mergeLive`). The read path never reads `_conversations`: the live
 * conversation (title, status) is read on the web through
 * `sessionConversations` and wins over this snapshot, which only fills in for
 * a conversation since deleted (rows live in the per-worktree DB fork and go
 * with their task) or one the live lookup has not answered.
 */
export interface ArchivedMeta {
  conversationId: string | null;
  title: string | null;
}

// Per-conversation token totals (one per JSONL file). `cost` is the exact sum of
// this session's own priced (date, model, speed) buckets — see usage-index
// rollup.
export interface PerSession {
  sessionId: string;
  projectDir: string;
  isSingularity: boolean;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  cost: number;
  lastActivity: string;
  modelsUsed: string[];
}

/** What the read path answers from — every `stats.cost.*` value (`./answers.ts`). */
export interface AggregateBundle {
  daily: DailyRow[];
  sessions: PerSession[];
  // Encoded project dir → isSingularity?
  projectIsSingularity: Map<string, boolean>;
  archivedMeta: Map<string, ArchivedMeta>;
}

/**
 * `buildBundle`'s full result: the read-path bundle PLUS the two things only the
 * capture path (warm-up, daily job) consumes — the merged archive to flush and
 * the anomalies to report. Kept off `AggregateBundle` so a value loader
 * (`./answers.ts`) cannot accidentally reach for a durable-write payload.
 */
interface BundleBuild {
  bundle: AggregateBundle;
  merged: Map<string, ArchiveEntry>;
  unpriced: UnpricedModel[];
  shrunk: ArchiveShrink[];
}

// Both files, and the year-sharded archive beside them, live in the host-global
// usage dir this plugin declares in its `data-dirs/index.ts`.
const INDEX_PATH = costUsageDir.file("index.json");
const PRICE_TABLE_PATH = costUsageDir.file("price-table.json");

// The incremental host-global transcript index — the generic mechanics
// (enumerate → (mtime,size) fingerprint diff → bounded parse → atomic persist →
// drop-vanished) live in `infra/corpus-index`; this instance supplies the
// cost-specific `parseTranscript`. Only main persists the shared index; worktree
// backends read it and compute any delta in-memory (scope: "host"). Every
// loadBundle calls `ensureFresh()` — the lazy on-read stat-diff correctness
// fallback that makes the deferred warmup safe.
//
// This index is the LIVE corpus only: `refreshCorpus` drops paths that vanished
// from disk, which is precisely why the permanent archive (`archive.ts`) exists
// and why every read merges the two.
const costIndex = defineCorpusIndex<FilePartial>({
  name: "stats.cost.usage",
  description:
    "Indexes the token usage recorded in agent transcripts so cost stats can be computed quickly.",
  roots: [CLAUDE_PROJECTS_DIR],
  match: (p) => p.endsWith(".jsonl"),
  parse: parseTranscript,
  indexPath: INDEX_PATH,
  scope: "host",
  version: INDEX_VERSION,
  concurrency: 6,
});

// The price table, read from disk once per process and merged/refreshed by the
// daily job. The vendored LiteLLM snapshot is the floor for a machine that has
// never fetched (first boot, offline) — never a silent empty table, which would
// price the whole corpus as unknown-model.
let priceTable: PriceTable | null = null;
let priceTableInflight: Promise<PriceTable> | null = null;

async function ensurePriceTable(): Promise<PriceTable> {
  if (priceTable) return priceTable;
  priceTableInflight ??= (async () => {
    try {
      const loaded = await loadPriceTable(PRICE_TABLE_PATH);
      priceTable = loaded ?? (await loadFallbackPriceTable());
      return priceTable;
    } finally {
      priceTableInflight = null;
    }
  })();
  return priceTableInflight;
}

/**
 * Fetch LiteLLM's live table, merge it into what we already hold, persist, and
 * adopt it in-process. Driven by the daily refresh job.
 *
 * The merge NEVER deletes a key (see `mergePriceTable`), so a model BerriAI has
 * since pruned keeps the price we learned while it existed — the archive spans
 * years and would otherwise silently reprice that history as unknown-model.
 */
export async function refreshPriceTable(): Promise<{ models: number }> {
  const [existing, fetched] = await Promise.all([
    ensurePriceTable(),
    fetchPriceTable(),
  ]);
  const next = mergePriceTable(existing, fetched);
  await savePriceTable(PRICE_TABLE_PATH, next);
  priceTable = next;
  for (const listener of priceTableListeners) listener();
  return { models: Object.keys(next.models).length };
}

const priceTableListeners = new Set<() => void>();

/**
 * The price table every cost in the app is priced with — the same one Stats →
 * Cost reads (loaded once per process, the vendored snapshot as its floor).
 */
export async function currentPriceTable(): Promise<PriceTable> {
  return await ensurePriceTable();
}

/**
 * Hear when the daily refresh adopts a new price table, so a consumer that
 * stores priced totals re-prices them. Called synchronously after the save: a
 * listener must be cheap (enqueue its work) and must not throw. Returns the
 * unsubscribe.
 */
export function onPriceTableUpdated(listener: () => void): () => void {
  priceTableListeners.add(listener);
  return () => priceTableListeners.delete(listener);
}

// The permanent archive, read from disk ONCE per process. `buildBundle` folds the
// live corpus into it on every read (pure) and adopts the result, so a transcript
// that Claude Code deletes mid-process stays banked in memory until the next
// flush instead of being lost between the boot load and the daily write.
let archive: Map<string, ArchiveEntry> | null = null;
let archiveInflight: Promise<Map<string, ArchiveEntry>> | null = null;

async function ensureArchive(): Promise<Map<string, ArchiveEntry>> {
  if (archive) return archive;
  archiveInflight ??= (async () => {
    try {
      archive = await loadArchive(costUsageDir.path);
      return archive;
    } finally {
      archiveInflight = null;
    }
  })();
  return archiveInflight;
}

/**
 * Load, merge and price. Pure with respect to disk: it writes NOTHING — the
 * archive flush lives in `captureCostHistory` (warm-up + daily job).
 *
 * `conv` is the live conversation metadata the archive snapshots: the capture
 * path reads it from `_conversations`; the read path passes `NO_CONV_META` and
 * never touches Postgres (its values are served external — the snapshot a
 * merge already holds is kept, `mergeLive` never overwrites a title with a
 * missing one).
 */
async function buildBundle(
  conv: Map<string, ArchiveConvMeta>,
): Promise<BundleBuild> {
  await costIndex.ensureFresh();
  const [table, banked, mainRoot] = await Promise.all([
    ensurePriceTable(),
    ensureArchive(),
    ensureMainWorktreeRoot(),
  ]);
  const repoBasename = mainRoot.split("/").pop() ?? "";

  const { merged, shrunk } = mergeLive(
    banked,
    costIndex.entries(),
    conv,
    repoBasename,
  );
  // Adopt the merge: the in-memory archive is monotonic for the life of the
  // process, so a file deleted after boot is still flushed by the daily job.
  archive = merged;

  // Everything downstream reads the MERGED set — live ∪ archived. Rolling up
  // `costIndex.entries()` here would price only the transcripts that still exist
  // on disk, i.e. exactly the retroactive truncation the archive exists to end.
  const partials = new Map<string, FilePartial>();
  for (const [path, entry] of merged) partials.set(path, entry.partial);
  const { daily, sessions, unpriced } = rollup(partials, table);

  const projectIsSingularity = classifyProjects(merged.values(), repoBasename);
  const decorated = sessions.map((s: SessionRollup): PerSession => ({
    ...s,
    isSingularity: projectIsSingularity.get(s.projectDir) ?? false,
  }));
  return {
    bundle: {
      daily,
      sessions: decorated,
      projectIsSingularity,
      archivedMeta: archivedMetaOf(merged),
    },
    merged,
    unpriced,
    shrunk,
  };
}

const NO_CONV_META = new Map<string, ArchiveConvMeta>();

// ─── The read path: one memoized bundle, and what invalidates it ─────────────
//
// Every `stats.cost.*` value (`./served.ts`) is answered from ONE bundle. Its
// inputs are the transcripts (the corpus index), the price table and the
// in-memory archive — none of them Postgres — and each has a change signal:
//
//   • a transcript written under `~/.claude/projects`: on main, the corpus
//     index's own watcher (`costIndex.onChange`, one recursive watch for the
//     process); where that watcher is not running (a worktree backend, or main
//     before its warm-up), the directory watch a subscribed tuple holds
//     (`watchCostInputs`);
//   • a new price table: `onPriceTableUpdated` in the process that refreshed it
//     (the daily job); every OTHER backend watches `price-table.json` itself
//     and reloads it, since the job runs on main only;
//   • the archive: only `buildBundle` changes it — a read's own merge, or a
//     capture (`captureCostHistory` notifies after it). The capture runs on
//     main only, so a worktree backend's archive is the one it loaded at its
//     first read plus its own merges, for the life of the process: main's
//     later captures (new title snapshots, a shrink banked) do not reach it.
//
// Each bumps `generation`; the bundle is rebuilt once per generation however
// many values (and tuples) read it. Nothing watches while nobody subscribes,
// so a first subscriber bumps the generation, and a read with no subscriber
// at all (an HTTP read) never trusts the memo.
//
// Transcripts are written every few seconds while any agent runs, and a
// rebuild re-walks the corpus index and re-prices every session (seconds of
// work), so their signal is coalesced HERE, at the source: the first write
// arms one trailing window, every write inside it folds into it, and the
// window's end is one generation and one notify of every holder. The values'
// `throttleMs` could not do it — the runtime drains a throttled entry early
// whenever any other resource flushes, which on a busy server is always
// (measured: ~18 rebuilds a minute behind a declared 30 s throttle).
const TRANSCRIPT_COALESCE_MS = 30_000;
let transcriptWindow: ReturnType<typeof setTimeout> | undefined;

interface Holder {
  notify: () => void;
}
const holders = new Set<Holder>();
let generation = 0;
let memo: MemoEntry | null = null;

/** Every subscribed tuple re-reads, over a rebuilt bundle. */
function costInputsChanged(): void {
  generation++;
  for (const h of holders) h.notify();
}

onPriceTableUpdated(costInputsChanged);

/**
 * Hear every change to what the bundle reads, for as long as a tuple is
 * subscribed (`whileSubscribed`): a transcript written, a price-table update,
 * a capture (see the block above for each signal). Returns the stop.
 */
export async function watchCostInputs(notify: () => void): Promise<() => void> {
  const holder: Holder = { notify };
  const first = holders.size === 0;
  // Nothing watched the inputs until now: whatever the memo holds may be stale.
  if (first) generation++;
  holders.add(holder);
  const releases: (() => void)[] = [];
  try {
    if (costIndex.watching()) {
      // Main, past its warm-up: the index already watches the corpus, armed
      // long before this subscriber — reuse its signal, no second watch.
      releases.push(costIndex.onChange(transcriptsWritten));
    } else {
      releases.push(
        await acquireDirWatch({
          dir: CLAUDE_PROJECTS_DIR,
          scope: "subtree",
          onChange: (events) => {
            if (!events.some((e) => e.path.endsWith(".jsonl"))) return;
            transcriptsWritten();
          },
        }),
      );
    }
    if (!isHostSingleton()) {
      // The daily refresh runs in the host singleton only; another backend
      // hears its new table through the file it saves.
      releases.push(
        await acquireDirWatch({
          dir: costUsageDir.path,
          scope: "children",
          onChange: (events) => {
            if (!events.some((e) => e.path === PRICE_TABLE_PATH)) return;
            priceTable = null;
            costInputsChanged();
          },
        }),
      );
    }
  } catch (err) {
    holders.delete(holder);
    for (const release of releases) release();
    throw err;
  }
  // A load that ran while the watches above were opening built the memo
  // before a write in that gap could be heard: redo it against what is there
  // now. (`memo.generation === generation` is exactly "a load ran since the
  // bump"; nothing ran ⇒ nothing to redo.)
  if (first && memo !== null && memo.generation === generation) {
    costIndex.markDirty();
    costInputsChanged();
  }
  return () => {
    holders.delete(holder);
    for (const release of releases) release();
    if (holders.size === 0 && transcriptWindow !== undefined) {
      clearTimeout(transcriptWindow);
      transcriptWindow = undefined;
    }
  };
}

/**
 * A transcript was written: fold it into the open coalescing window, or open
 * one. Every holder's watch callback lands here, so one write is one window
 * however many tuples are subscribed.
 */
function transcriptsWritten(): void {
  // On main `ensureFresh` skips the walk until its own watcher marks the
  // index dirty — which may not have fired yet for this batch.
  costIndex.markDirty();
  if (transcriptWindow !== undefined) return;
  transcriptWindow = setTimeout(() => {
    transcriptWindow = undefined;
    costInputsChanged();
  }, TRANSCRIPT_COALESCE_MS);
}

/** The read path's bundle: rebuilt once per input change, never touching Postgres. */
export function loadBundle(): Promise<AggregateBundle> {
  if (holders.size > 0 && memo !== null && memo.generation === generation) {
    return memo.bundle;
  }
  const entry: MemoEntry = {
    generation,
    bundle: buildReadBundle(() => entry),
  };
  memo = entry;
  return entry.bundle;
}

interface MemoEntry {
  generation: number;
  bundle: Promise<AggregateBundle>;
}

async function buildReadBundle(
  self: () => MemoEntry,
): Promise<AggregateBundle> {
  try {
    return (await buildBundle(NO_CONV_META)).bundle;
  } catch (err) {
    // A failed build is not an answer to keep: the next read retries. Only
    // its OWN entry is dropped — a newer generation's build may hold the memo.
    if (memo === self()) memo = null;
    throw err;
  }
}

/**
 * Bank the current merged state to disk and surface the anomalies the merge and
 * the pricing pass found.
 *
 * Called from exactly two places — the boot warm-up and the daily refresh job —
 * because it WRITES. Transcripts only vanish after 30 untouched days, so a daily
 * flush plus one at boot leaves a ~30× margin; flushing per request would put a
 * whole-shard `JSON.stringify` on the serving path.
 *
 * `isHostSingleton()`, never `isMain()`: in a compiled release the single backend
 * runs under the composition name, so an `isMain()` gate here would silently mean
 * the archive is never written there — invisible, because there is no second
 * backend to notice.
 *
 * That gate is correct but not yet sufficient: BOTH callers are still reached
 * through upstream `isMain()` gates (the warmup executor skips `scope: "host"`,
 * graphile's cron builder skips non-`perWorktree` schedules), so today the
 * archive is written in dev only. See the deferred note on `costRefreshJob`.
 */
export async function captureCostHistory(): Promise<void> {
  const { merged, unpriced, shrunk } = await buildBundle(await loadConvMeta());
  // The merge refreshed the archive's snapshots: the open charts re-read.
  costInputsChanged();
  await reportCostAnomalies(unpriced, shrunk);
  if (!isHostSingleton()) return;
  await flushArchive(costUsageDir.path, merged);
}

// The usage index's declared file watcher (main-only), opened by the warm-up's
// `startWatcher()` below — mounted next to it.
export const costUsageWatcher = costIndex.watcher;

// Declared heavy boot warm-up (replacing the former raw `onReady` prewarm): warm
// the host-global usage index and start the corpus watcher on MAIN
// ONLY (`scope: "host"`), DEFERRED past serving-ready and THROTTLED by the
// warmup executor instead of competing with first requests on `onReady`. The
// index is shared across worktrees, so a single writer keeps it fresh and no
// worktree backend pays the parse. A request arriving before the drain still
// serves correctly via the on-demand `ensureFresh()` fallback in `loadBundle`.
export const costUsageWarmup = defineWarmup({
  name: "stats.cost.usage",
  description:
    "Loads the transcript usage index after startup and keeps it fresh so cost stats open instantly.",
  scope: "host",
  run: warmAndWatch,
});

async function warmAndWatch(): Promise<void> {
  // Watcher first so no corpus change is missed between warm and watch-start.
  await costIndex.startWatcher();
  // Warms the same path a request takes AND banks it — one of the archive's two
  // write points (the other is the daily job), so a dev machine whose backend
  // restarts often still captures history even if the cron tick is missed.
  // Both paths are `isMain()`-gated upstream — see the note on `costRefreshJob`.
  await captureCostHistory();
}

// ─── helpers ─────────────────────────────────────────────────────────────────

/**
 * The live `_conversations` metadata the archive snapshots (title + id —
 * the archive is not a mirror of live state). CAPTURE PATH ONLY: the read
 * path's values are external and read no Postgres.
 */
async function loadConvMeta(): Promise<Map<string, ArchiveConvMeta>> {
  const rows = await db
    .select({
      id: _conversations.id,
      title: _conversations.title,
      claudeSessionId: _conversations.claudeSessionId,
    })
    .from(_conversations)
    .where(isNotNull(_conversations.claudeSessionId));
  const out = new Map<string, ArchiveConvMeta>();
  for (const r of rows) {
    if (!r.claudeSessionId) continue;
    out.set(r.claudeSessionId, { conversationId: r.id, title: r.title });
  }
  return out;
}

/** Each archived session's snapshotted conversation, by Claude session id. */
function archivedMetaOf(
  merged: Map<string, ArchiveEntry>,
): Map<string, ArchivedMeta> {
  const out = new Map<string, ArchivedMeta>();
  for (const entry of merged.values()) {
    if (entry.title === null && entry.conversationId === null) continue;
    out.set(entry.partial.sessionId, {
      conversationId: entry.conversationId,
      title: entry.title,
    });
  }
  return out;
}

// Classify every project dir the MERGED set knows about as Singularity-related
// or not, by matching the encoded dir name against the main repo basename (see
// `isSingularityProjectDir` for the encoding and why the user prefix is ignored).
//
// Two things this must not be:
//
//   • a `readdir` of `~/.claude/projects` — a dir absent from the listing
//     resolved to `false` through the callers' `?? false`, and since the default
//     scope is `"singularity"`, that silently hid a project's sessions from every
//     chart as soon as its directory left disk;
//   • live-only — the membership set is the merged partials, so an archived
//     project whose directory Claude Code has since deleted still classifies.
//
// The stored `isSingularity` is the OR-fallback: `repoBasename` comes from the
// current main worktree root, so renaming or relocating the repo would otherwise
// reclassify all archived history as non-Singularity in one shot.
function classifyProjects(
  entries: Iterable<ArchiveEntry>,
  repoBasename: string,
): Map<string, boolean> {
  const out = new Map<string, boolean>();
  for (const e of entries) {
    const dir = e.partial.projectDir;
    const live =
      repoBasename !== "" && isSingularityProjectDir(dir, repoBasename);
    out.set(dir, (out.get(dir) ?? false) || live || e.isSingularity);
  }
  return out;
}

// CLI model name (e.g. "claude-opus-4-7-20250101") → model id "opus-4-7"; a
// name outside the id grammar (an old "claude-3-5-sonnet" spelling) stays as is.
export function canonicalModel(name: string): string {
  const id = modelIdFromCliName(name);
  return id.ok ? id.id : name;
}
