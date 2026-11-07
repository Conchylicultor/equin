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
  readGrouped,
  recordKey,
  recordWorkerCount,
  repoModuleOf,
  runRecordJobs,
  type RecordStore,
} from "@plugins/plugin-meta/plugins/plugin-records/core";
import { pluginFilesManifest } from "./fs-snapshot";
import type { PluginNode } from "@plugins/plugin-meta/plugins/plugin-tree/core";
import {
  extractFacets,
  FACET_EXTRACTION_URL,
  facetJobRequest,
  relDirOf,
  type FacetJobReply,
  type FacetJobRequest,
} from "./facet-extraction";

/**
 * Facets as PLUGIN RECORDS: each facet's extract of each plugin, stored under
 * the hash of the plugin's own files and the facet's code, in a store every
 * worktree shares. A build that changed nothing extracts nothing; one edit
 * re-extracts the facets of the plugin it touched; a fresh worktree from main
 * finds main's records.
 *
 * This module computes the keys, reads and writes the store and schedules the
 * missed extractions on workers — none of which can change a record's value,
 * so its code keys no record. The extraction itself (the strict snapshot, the
 * job body) is the harness, `facet-extraction.ts`, whose Merkle key is in every
 * facet record; what decides WHICH plugin is extracted (its dir, id and files)
 * is in each record's key already.
 */

/**
 * Every module whose Merkle key keys facet records: the extraction harness
 * and each facet's own module — the producers the facet key-width check
 * measures.
 */
export async function facetRecordProducers(repo: RepoFiles): Promise<string[]> {
  const sources = await loadFacetSources(await loadFacets());
  return [facetExtractionHarness(repo), ...sources.values()];
}

/** This module, repo-relative: the record plumbing the harness must never load. */
export function facetRecordsModule(repo: RepoFiles): string {
  return repoModuleOf(repo, import.meta.url);
}

/** The extraction harness's module, repo-relative: the one producer keyed into every facet record. */
export function facetExtractionHarness(repo: RepoFiles): string {
  return repoModuleOf(repo, FACET_EXTRACTION_URL);
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
  const harnessModule = facetExtractionHarness(input.snapshot);
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
  // One group per plugin: a no-change build asks the store ~1.7k keys, not
  // one per (plugin, facet) (~18.7k).
  const texts = readGrouped(
    store,
    "facet",
    [...keyed.values()].map((perFacet) => [...perFacet.values()]),
  );

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
    chunks.map((chunk) => facetJobRequest(snapshot, chunk, wantedOf)),
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

/**
 * The extraction run on a worker: registered by THIS module (a worker imports
 * it to find the job), its body the harness's.
 */
const extractFacetsJob = defineRecordJob<FacetJobRequest, FacetJobReply>(
  import.meta.url,
  "extract-facets",
  extractFacets,
);
