import type {
  RepoFiles,
  RepoSnapshot,
} from "@plugins/framework/plugins/tooling/core";
import { setFacet, type Facet } from "@plugins/plugin-meta/plugins/facets/core";
import {
  loadFacets,
  loadFacetSources,
} from "@plugins/plugin-meta/plugins/facets/plugins/loader/core";
import {
  buildModuleGraph,
  defineRecordJob,
  recordKey,
  recordWorkerCount,
  repoModuleOf,
  runRecordJobs,
  type RecordStore,
} from "@plugins/plugin-meta/plugins/plugin-records/core";
import {
  runWithFsSnapshot,
  type FsSnapshot,
} from "@plugins/plugin-meta/plugins/parse-utils/core";
import type { AppPath } from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import { createTimeSlicer } from "@plugins/packages/plugins/macrotask-yield/core";
import { buildFsSnapshot, pluginFilesManifest } from "./fs-snapshot";
import type { PluginNode } from "@plugins/plugin-meta/plugins/plugin-tree/core";

/**
 * Facets as PLUGIN RECORDS: each facet's extract of each plugin, stored under
 * the hash of the plugin's own files and the facet's code, in a store every
 * worktree shares. A build that changed nothing extracts nothing; one edit
 * re-extracts the facets of the plugin it touched; a fresh worktree from main
 * finds main's records.
 *
 * The extract of a record that missed runs under a STRICT snapshot of the
 * missed plugins' files: a facet reading a file its record's key does not name
 * throws, so a record can never silently depend on something that will not
 * invalidate it.
 */

/**
 * The extraction harness: THIS module, which runs every extraction (the
 * strict snapshot it builds, the job a worker runs). Its Merkle key covers what
 * it imports; what decides WHICH plugin is extracted (its dir, id and files) is
 * in each record's key already, so the tree builder above it is not.
 */
const HARNESS_URL = import.meta.url;

/**
 * Every module whose Merkle key keys facet records: the extraction harness
 * and each facet's own module — the producers the facet key-width check
 * measures.
 */
export async function facetRecordProducers(repo: RepoFiles): Promise<string[]> {
  const sources = await loadFacetSources(await loadFacets());
  return [repoModuleOf(repo, HARNESS_URL), ...sources.values()];
}

export interface FacetRecordsInput {
  snapshot: RepoSnapshot;
  store: RecordStore;
  /** A file outside the snapshot, from disk (null when absent). */
  readOutside(rel: string): string | null;
}

/**
 * Each facet's identity: the Merkle key of its own module and of the
 * extraction harness, plus the lockfile (the npm code a facet runs: the
 * transpiler, Tailwind) and the store's environment (the runtime's version).
 */
async function facetIdentities(
  input: FacetRecordsInput,
  facets: readonly Facet[],
): Promise<Map<string, string>> {
  const sources = await loadFacetSources(facets);
  const harnessModule = repoModuleOf(input.snapshot, HARNESS_URL);
  const graph = await buildModuleGraph(input, [
    harnessModule,
    ...sources.values(),
  ]);
  const harness = [graph.keyOf(harnessModule)];
  const env = [
    input.store.environment,
    input.snapshot.has("bun.lock") ? input.snapshot.blobOf("bun.lock") : "-",
  ];
  const out = new Map<string, string>();
  for (const f of facets) {
    out.set(
      f.def.id,
      recordKey(
        "facet",
        f.def.id,
        graph.keyOf(sources.get(f.def.id)!),
        ...harness,
        ...env,
      ),
    );
  }
  return out;
}

/**
 * What keys every facet record of one snapshot: each facet's identity (its
 * code, the harness, the environment) and the blobs of its batch inputs.
 * Computed once per snapshot; a long-lived reader recomputes only
 * {@link batchInputsOf} when one of those files changes.
 */
export interface FacetKeying {
  identities: Map<string, string>;
  /** Per batch facet, its inputs' `path\tblob` lines — part of its key. */
  batchInputs: Map<string, string[]>;
}

export async function facetKeying(
  input: FacetRecordsInput,
  facets: readonly Facet[],
): Promise<FacetKeying> {
  return {
    identities: await facetIdentities(input, facets),
    batchInputs: batchInputsOf(input.snapshot, facets),
  };
}

/** Each batch facet's inputs as `path\tblob` lines (see {@link FacetKeying}). */
export function batchInputsOf(
  snapshot: RepoSnapshot,
  facets: readonly Facet[],
): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const f of facets) {
    if (!f.extractBatch) continue;
    out.set(
      f.def.id,
      f.extractBatch.inputs.map((p) => `${p}\t${snapshot.blobOf(p)}`),
    );
  }
  return out;
}

/**
 * One plugin's record key per facet: the facet's identity over the plugin's
 * own files (`pluginFilesManifest`) and the facet's batch inputs. A function
 * of the plugin's folder alone, so a reader that knows which folders changed
 * re-keys only those plugins.
 */
export function nodeFacetKeys(
  snapshot: RepoSnapshot,
  keying: FacetKeying,
  facets: readonly Facet[],
  node: PluginNode,
): Map<string, string> {
  const relDir = relDirOf(snapshot, node);
  const files = pluginFilesManifest(snapshot, node.dir).sort();
  const own = recordKey("own", relDir, node.id, ...files);
  const perFacet = new Map<string, string>();
  for (const f of facets) {
    perFacet.set(
      f.def.id,
      recordKey(
        keying.identities.get(f.def.id)!,
        own,
        ...(keying.batchInputs.get(f.def.id) ?? []),
      ),
    );
  }
  return perFacet;
}

/**
 * The record text of every `(node, facet)` key given, read from the store and
 * extracted (and stored) only where it missed. The missed plugins' files are
 * the only ones read.
 */
export async function facetRecordTexts(
  input: FacetRecordsInput,
  facets: readonly Facet[],
  keyed: ReadonlyMap<PluginNode, ReadonlyMap<string, string>>,
): Promise<Map<string, string>> {
  const { snapshot, store } = input;
  const wanted: string[] = [];
  for (const perFacet of keyed.values()) wanted.push(...perFacet.values());
  const texts = store.getMany("facet", wanted);

  // Nodes with at least one missed facet: the only plugins whose files are read.
  const missed = [...keyed.keys()].filter((n) =>
    [...keyed.get(n)!.values()].some((k) => !texts.has(k)),
  );
  if (missed.length === 0) return texts;
  const wantedOf = (node: PluginNode): string[] =>
    facets
      .filter((f) => !texts.has(keyed.get(node)!.get(f.def.id)!))
      .map((f) => f.def.id);
  const chunks = chunksOf(missed);
  const requests = await Promise.all(
    chunks.map(async (chunk): Promise<FacetJobRequest> => {
      const fs = await buildFsSnapshot(
        snapshot,
        chunk.map((n) => n.dir),
        { strict: STRICT },
      );
      return {
        root: snapshot.root,
        files: [...fs.files],
        dirs: [...fs.dirs].map(([dir, entries]) => [
          dir,
          entries.map((e) => [e.name, e.isDirectory()] as const),
        ]),
        plugins: chunk.map((node) => ({
          dir: node.dir,
          relDir: relDirOf(snapshot, node),
          id: node.id,
          facets: wantedOf(node),
        })),
      };
    }),
  );
  const replies = await runRecordJobs(extractFacetsJob, requests);
  const fresh: [string, string][] = [];
  chunks.forEach((chunk, c) => {
    chunk.forEach((node, i) => {
      for (const [facetId, text] of replies[c]![i]!)
        fresh.push([keyed.get(node)!.get(facetId)!, text]);
    });
  });
  store.putMany("facet", fresh);
  for (const [k, text] of fresh) texts.set(k, text);
  return texts;
}

/**
 * Fill every node's facets from the records, extracting (and storing) only
 * the ones that missed.
 */
export async function extractFacetRecords(
  input: FacetRecordsInput,
  nodes: readonly PluginNode[],
  facets: readonly Facet[],
): Promise<void> {
  const keying = await facetKeying(input, facets);
  const keyed = new Map<PluginNode, Map<string, string>>();
  for (const node of nodes)
    keyed.set(node, nodeFacetKeys(input.snapshot, keying, facets, node));
  const texts = await facetRecordTexts(input, facets, keyed);

  // Every node's data is parsed from its record's text, hit or fresh: one
  // spelling, so a fresh extraction and a stored one cannot differ by what
  // JSON drops (an `undefined` field, a Map).
  for (const node of nodes) {
    for (const f of facets) {
      const text = texts.get(keyed.get(node)!.get(f.def.id)!);
      if (text === undefined)
        throw new Error(
          `[plugin-tree] no record for facet "${f.def.id}" of ${node.path}`,
        );
      setFacet(node, f.def, JSON.parse(text) as unknown);
    }
  }
}

/** What the strict snapshot of a record's extraction covers, for its refusal message. */
const STRICT = "the files of the plugins whose records are being made";

/**
 * Below this many missed plugins per worker, a worker's start (its JIT, its
 * facet modules) costs more than it saves: a warm build's handful of misses
 * stays in this process.
 */
const MIN_PLUGINS_PER_WORKER = 64;

/**
 * The missed plugins in contiguous runs of the tree's order (neighbours share
 * folders and the facets' per-umbrella reads), one per worker that pays.
 */
function chunksOf(nodes: readonly PluginNode[]): PluginNode[][] {
  const n = Math.max(
    1,
    Math.min(
      recordWorkerCount(),
      Math.floor(nodes.length / MIN_PLUGINS_PER_WORKER),
    ),
  );
  const out: PluginNode[][] = [];
  for (let i = 0; i < n; i++)
    out.push(
      nodes.slice(
        Math.floor((i * nodes.length) / n),
        Math.floor(((i + 1) * nodes.length) / n),
      ),
    );
  return out;
}

/** One worker's share of the missed extractions: plain data, structured-cloned. */
interface FacetJobRequest {
  root: AppPath;
  /** The strict snapshot of exactly these plugins' files. */
  files: [string, string][];
  dirs: [string, (readonly [name: string, isDir: boolean])[]][];
  plugins: { dir: AppPath; relDir: string; id: string; facets: string[] }[];
}

/** Per plugin, in request order: each extracted facet's record text. */
type FacetJobReply = [facetId: string, text: string][][];

let facetsOnce: Promise<Facet[]> | undefined;

/**
 * Extract the missed facets of a run of plugins, then each batch facet over
 * the run — the same calls in a worker as in this process. A batch facet's
 * pass is per plugin (each plugin's result is a function of its own files and
 * the batch's named inputs, which key its record), so splitting the plugins
 * across workers cannot change a record.
 */
const extractFacetsJob = defineRecordJob<FacetJobRequest, FacetJobReply>(
  import.meta.url,
  "extract-facets",
  async (req) => {
    const facets = await (facetsOnce ??= loadFacets());
    const byId = new Map(facets.map((f) => [f.def.id, f]));
    const fs: FsSnapshot = {
      files: new Map(req.files),
      dirs: new Map(
        req.dirs.map(([dir, entries]) => [
          dir,
          entries.map(([name, isDir]) => ({
            name,
            isFile: () => !isDir,
            isDirectory: () => isDir,
          })),
        ]),
      ),
      strict: STRICT,
    };
    const extracted: Map<string, unknown>[] = [];
    const slice = createTimeSlicer();
    for (const p of req.plugins) {
      const data = new Map<string, unknown>();
      for (const facetId of p.facets) {
        const f = byId.get(facetId);
        if (!f) throw new Error(`[plugin-tree] no facet "${facetId}"`);
        data.set(
          facetId,
          runWithFsSnapshot(fs, () =>
            f.extract({ dir: p.dir, relDir: p.relDir, pluginId: p.id, fs }),
          ),
        );
        await slice();
      }
      extracted.push(data);
    }
    for (const f of facets) {
      if (!f.extractBatch) continue;
      const plugins = req.plugins.flatMap((p, i) => {
        const data = extracted[i]!.get(f.def.id);
        return data === undefined ? [] : [{ dir: p.dir, data }];
      });
      if (plugins.length > 0)
        await f.extractBatch.run({ root: req.root, fs, plugins });
    }
    return extracted.map((data) =>
      [...data].map(([facetId, value]) => [facetId, JSON.stringify(value)]),
    );
  },
);

function relDirOf(snapshot: RepoSnapshot, node: PluginNode): string {
  const root = snapshot.root.endsWith("/")
    ? snapshot.root
    : `${snapshot.root}/`;
  if (!node.dir.startsWith(root))
    throw new Error(`[plugin-tree] ${node.dir} is not under ${snapshot.root}`);
  return node.dir.slice(root.length);
}
