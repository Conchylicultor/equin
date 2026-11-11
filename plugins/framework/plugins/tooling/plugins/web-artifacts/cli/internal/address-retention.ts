// Address-dir retention: a served namespace's address dir holds the names some
// graph NEEDED RECENTLY — not every name the namespace ever composed.
//
// The address dir (`seedAddressDir`, compose's `addressDir`) is what lets an
// open tab keep loading the build it booted from. Every link in it is a prune
// root, so with nothing ever leaving it the artifact store grew with every
// build of every namespace (main's dir reached 80k links, the store 115k
// entries, 2026-11-11) — the store's own age/count rules could never apply.
//
// The rule now: a graph (one composed bundle, `.build-graph`) is NEEDED while
// it is composed or served by a build of the namespace, or named by an open
// tab (the backend touches its record when a tab's subscription names it —
// `build/server-build-id`). An address stays while some graph needing it was
// needed within {@link ADDRESS_RETENTION_MS}; the graph this build composed
// and the graph still being served always stay. A tab whose graph aged out
// asks for an address that is gone: its load fails, and the app says so (the
// red "part of the app didn't load — reload" chip), never silently.
//
// Bookkeeping, per namespace, beside the dist (`webGraphRecordsDir`):
//   - one record per graph, `<graph>.names`: the names that graph links, one per
//     line; its mtime is when the graph was last needed.
//   - `index.json`: each name's last-needed time and, per record, the mtime it
//     was folded at — so a build reads only the records written or touched
//     since the previous build, never every record (O(changes), not O(graphs)).
//
// Runs inside the build, before the publish, under the checkout's `.build.lock`
// — the only writer of this namespace's address dir — so nothing can add a
// link it is about to remove. The prune job never edits an address dir; a link
// removed here only makes its store entry unreferenced, and the store's own
// rules (age, count cap) then reclaim it.

import {
  mkdirSync,
  renameSync,
  rmSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  statSync,
} from "@plugins/packages/plugins/timed-fs/core";

/**
 * How long an address stays after the last graph needing it was needed: a tab
 * left overnight (frozen, its socket closed, so it names its graph to nobody)
 * still loads its own build in the morning. Main gains ~5–15k new names a day,
 * so its address dir holds about a day of them plus its current fleet.
 */
export const ADDRESS_RETENTION_MS = 24 * 60 * 60 * 1000;

const RECORD_SUFFIX = ".names";
const INDEX_FILE = "index.json";

const indexSchema = z.object({
  v: z.literal(1),
  /** Record (graph) → the mtime it was last folded at. */
  graphs: z.record(z.string(), z.number()),
  /** Address-dir name → when a graph needing it was last needed (ms). */
  names: z.record(z.string(), z.number()),
});
type AddressIndex = z.infer<typeof indexSchema>;

export interface AddressRetentionResult {
  /** Names the address dir holds after the trim. */
  kept: number;
  /** Links removed from the address dir. */
  removed: number;
  /** Graph records left (each a graph needed within the window). */
  graphs: number;
  /** Records read this run (new, or touched by a tab since the last build). */
  recordsRead: number;
  /** True when the dir had no index yet: every link's age was read off it once. */
  migrated: boolean;
}

/**
 * Record the graph this build composed, then trim the namespace's address dir
 * to what the retained graphs need.
 *
 * @param opts.addressDir the namespace's address dir (compose linked this graph into it).
 * @param opts.graphsDir the namespace's graph records (`webGraphRecordsDir`).
 * @param opts.graph this build's graph hash, and `opts.names` every name it links.
 * @param opts.live the graph the namespace serves right now (the previous
 *   build's, until this one publishes) with its names, or null when nothing is
 *   served yet. Kept whatever its age: a failed deploy reverts to it.
 * @param opts.now the clock (test seam).
 */
export function retainAddresses(opts: {
  addressDir: string;
  graphsDir: string;
  graph: string;
  names: readonly string[];
  live: { graph: string; names: readonly string[] } | null;
  now?: number;
  retentionMs?: number;
}): AddressRetentionResult {
  const now = opts.now ?? Date.now();
  const cutoff = now - (opts.retentionMs ?? ADDRESS_RETENTION_MS);
  mkdirSync(opts.graphsDir, { recursive: true });

  // 1. The two graphs needed right now: the one composed, the one served.
  writeRecord(opts.graphsDir, opts.graph, opts.names, now);
  if (opts.live !== null && opts.live.graph !== opts.graph) {
    writeRecord(opts.graphsDir, opts.live.graph, opts.live.names, now);
  }

  // 2. The index, or — the first time — every existing link aged by when it
  // was linked (a link's own mtime: when compose added it).
  const indexPath = join(opts.graphsDir, INDEX_FILE);
  let index: AddressIndex;
  let migrated = false;
  if (existsSync(indexPath)) {
    index = indexSchema.parse(JSON.parse(readFileSync(indexPath, "utf8")));
  } else {
    migrated = true;
    index = { v: 1, graphs: {}, names: {} };
    for (const name of readdirSync(opts.addressDir)) {
      const st = lstatSync(join(opts.addressDir, name), {
        throwIfNoEntry: false,
      });
      if (st) index.names[name] = st.mtimeMs;
    }
  }

  // 3. Fold in every record written or touched since it was last folded.
  let recordsRead = 0;
  const records = new Map<string, number>(); // graph → mtime
  for (const file of readdirSync(opts.graphsDir)) {
    if (file.includes(".tmp.")) {
      // A write a crashed build left: only builds write here, one at a time.
      rmSync(join(opts.graphsDir, file), { force: true });
      continue;
    }
    if (!file.endsWith(RECORD_SUFFIX)) continue;
    const graph = file.slice(0, -RECORD_SUFFIX.length);
    const st = statSync(join(opts.graphsDir, file), { throwIfNoEntry: false });
    if (!st) continue; // a concurrent touch never deletes; nothing else runs
    records.set(graph, st.mtimeMs);
    if ((index.graphs[graph] ?? -Infinity) >= st.mtimeMs) continue;
    for (const name of readRecord(opts.graphsDir, graph)) {
      index.names[name] = Math.max(index.names[name] ?? -Infinity, st.mtimeMs);
    }
    index.graphs[graph] = st.mtimeMs;
    recordsRead++;
  }

  // 4. Drop the records and names no recent graph needs. The composed and the
  // served graph were stamped `now` above, so their names are all kept.
  const keepGraph = (graph: string): boolean =>
    graph === opts.graph || graph === opts.live?.graph;
  for (const [graph, mtime] of records) {
    if (mtime >= cutoff || keepGraph(graph)) continue;
    rmSync(join(opts.graphsDir, `${graph}${RECORD_SUFFIX}`), { force: true });
    records.delete(graph);
  }
  const graphs: Record<string, number> = {};
  for (const graph of records.keys()) {
    const folded = index.graphs[graph];
    if (folded !== undefined) graphs[graph] = folded;
  }
  const names: Record<string, number> = {};
  for (const [name, at] of Object.entries(index.names)) {
    if (at >= cutoff) names[name] = at;
  }
  for (const name of opts.names) names[name] ??= now;
  for (const name of opts.live?.names ?? []) names[name] ??= now;

  // 5. Unlink what is no longer kept. Every entry here is a symlink compose
  // made (or seeded); removing one never touches the store entry behind it.
  let removed = 0;
  for (const name of readdirSync(opts.addressDir)) {
    if (name in names) continue;
    try {
      unlinkSync(join(opts.addressDir, name));
      removed++;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }

  writeAtomic(indexPath, JSON.stringify({ v: 1, graphs, names }));
  return {
    kept: Object.keys(names).length,
    removed,
    graphs: records.size,
    recordsRead,
    migrated,
  };
}

/** Write `graph`'s record (once: a graph's names never change), stamped `at`. */
function writeRecord(
  graphsDir: string,
  graph: string,
  names: readonly string[],
  at: number,
): void {
  const file = join(graphsDir, `${graph}${RECORD_SUFFIX}`);
  if (!existsSync(file)) writeAtomic(file, [...names].sort().join("\n") + "\n");
  const t = new Date(at);
  utimesSync(file, t, t);
}

function readRecord(graphsDir: string, graph: string): string[] {
  return readFileSync(join(graphsDir, `${graph}${RECORD_SUFFIX}`), "utf8")
    .split("\n")
    .filter((n) => n !== "");
}

function writeAtomic(file: string, content: string): void {
  const tmp = `${file}.tmp.${process.pid}`;
  writeFileSync(tmp, content);
  renameSync(tmp, file);
}

/**
 * The graph a served dist names (`.build-graph`) and every name it links under
 * `artifacts/` — read off its record when there is one, else off the dist's
 * own manifest. Null when `distDir` serves nothing (first build) or predates
 * the graph pin.
 */
export function servedGraphOf(opts: {
  distDir: string;
  graphsDir: string;
}): { graph: string; names: string[] } | null {
  const graphFile = join(opts.distDir, ".build-graph");
  if (!existsSync(graphFile)) return null;
  const graph = readFileSync(graphFile, "utf8").trim();
  if (graph === "") return null;
  if (existsSync(join(opts.graphsDir, `${graph}${RECORD_SUFFIX}`))) {
    return { graph, names: readRecord(opts.graphsDir, graph) };
  }
  // Composed before graph records existed: every name its page can fetch is
  // under `/artifacts/<name>/` in its index.html (import map, preloads, entry).
  // Its worker-only links are not, so they may go — the build that recorded
  // this one re-links whatever its own graph still uses.
  const html = readFileSync(join(opts.distDir, "index.html"), "utf8");
  const names = new Set<string>();
  for (const m of html.matchAll(/\/artifacts\/([^/"'\s]+)\//g)) {
    if (m[1] !== undefined) names.add(m[1]);
  }
  // …and a crawl snapshot, served at the dist root through a link into it.
  for (const entry of readdirSync(opts.distDir, { withFileTypes: true })) {
    if (!entry.isSymbolicLink() || entry.name === "artifacts") continue;
    const target = readlinkSync(join(opts.distDir, entry.name));
    const m = /^artifacts\/([^/]+)/.exec(target);
    if (m?.[1] !== undefined) names.add(m[1]);
  }
  return { graph, names: [...names] };
}
