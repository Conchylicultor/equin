import type { RepoSnapshot } from "@plugins/framework/plugins/tooling/core";
import { setFacet, type Facet } from "@plugins/plugin-meta/plugins/facets/core";
import {
  loadFacets,
  loadFacetSources,
} from "@plugins/plugin-meta/plugins/facets/plugins/loader/core";
import {
  buildModuleGraph,
  npmResolutionsKey,
  defineRecordJob,
  readGrouped,
  recordKey,
  recordWorkerCount,
  codeCheckoutOf,
  runRecordJobs,
  type ModuleGraphInput,
  type OutsideFiles,
  type RecordStore,
} from "@plugins/plugin-meta/plugins/plugin-records/core";
import { sharedMemo } from "@plugins/packages/plugins/shared-work/core";
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
 * Where facet code is read from: the checkout the extraction harness lives in
 * (`codeCheckoutOf` — the set itself when it is that checkout, this process's
 * otherwise), never assumed to be the set whose plugins are extracted. Its
 * modules are repo-relative in that checkout: the harness, this module (the
 * record plumbing the harness must never load) and each facet's own module
 * (the facets this process loaded from its own registry).
 */
export interface FacetCode {
  code: ModuleGraphInput;
  harness: string;
  recordsModule: string;
  /** Facet id → its module. */
  sources: Map<string, string>;
}

export async function facetCode(
  input: ModuleGraphInput,
  facets?: readonly Facet[],
): Promise<FacetCode> {
  const { input: code, module: harness } = await codeCheckoutOf(
    input,
    FACET_EXTRACTION_URL,
  );
  const self = await codeCheckoutOf(input, import.meta.url);
  if (self.input.snapshot.root !== code.snapshot.root)
    throw new Error(
      `[faceted] the facet records module (${import.meta.url}) and the extraction harness (${FACET_EXTRACTION_URL}) are read from different checkouts`,
    );
  return {
    code,
    harness,
    recordsModule: self.module,
    sources: await loadFacetSources(facets ?? (await loadFacets())),
  };
}

/**
 * Every module whose Merkle key keys facet records — the extraction harness
 * and each facet's own module, the producers the facet key-width check
 * measures — with the checkout they are read from.
 */
export async function facetRecordProducers(
  input: ModuleGraphInput,
): Promise<{ code: ModuleGraphInput; modules: string[] }> {
  const { code, harness, sources } = await facetCode(input);
  return { code, modules: [harness, ...sources.values()] };
}

export interface FacetRecordsInput {
  snapshot: RepoSnapshot;
  store: RecordStore;
  /** A file outside the snapshot, from disk (null when absent). */
  readOutside: OutsideFiles;
}

/**
 * Each facet's identity: the Merkle key of its own module and of the
 * extraction harness (read from the checkout they live in, `facetCode`), plus the lockfile's npm resolutions (the npm code a facet runs: the
 * transpiler, Tailwind) and the store's environment (the runtime's version).
 */
async function facetIdentities(
  input: FacetRecordsInput,
  facets: readonly Facet[],
): Promise<Map<string, string>> {
  const {
    code,
    harness: harnessModule,
    sources,
  } = await facetCode(input, facets);
  const graph = await buildModuleGraph(code, [
    harnessModule,
    ...sources.values(),
  ]);
  const harness = [graph.keyOf(harnessModule)];
  const env = [code.store.environment, await npmResolutionsKey(code.snapshot)];
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
  const texts = await readGrouped(
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
 * Every plugin's facet record texts over one set, by plugin folder and facet
 * id: keyed, read, and extracted where they missed ONCE per set. A check pass
 * builds two faceted trees over its set (the barrel-free tree and the
 * enriched one, which only adds each facet's `enrich` and relates again):
 * both parse their data from these texts, so the second neither re-keys
 * ~1.3k plugins nor reads their records again.
 */
const facetTextsOver = sharedMemo(
  "facet records",
  async (
    _snapshot: RepoSnapshot,
    input: FacetRecordsInput,
    nodes: readonly PluginNode[],
    facets: readonly Facet[],
  ): Promise<{
    facets: readonly Facet[];
    byDir: Map<string, Map<string, string>>;
  }> => {
    const keying = await facetKeying(input, facets);
    const keyed = new Map<PluginNode, Map<string, string>>();
    for (const node of nodes)
      keyed.set(node, nodeFacetKeys(input.snapshot, keying, facets, node));
    const texts = await facetRecordTexts(input, facets, keyed);
    const byDir = new Map<string, Map<string, string>>();
    for (const [node, perFacet] of keyed) {
      const own = new Map<string, string>();
      for (const [facetId, key] of perFacet) {
        const text = texts.get(key);
        if (text === undefined)
          throw new Error(
            `[plugin-tree] no record for facet "${facetId}" of ${node.path}`,
          );
        own.set(facetId, text);
      }
      byDir.set(node.dir, own);
    }
    return { facets, byDir };
  },
);

/**
 * Fill every node's facets from the records, extracting (and storing) only
 * the ones that missed.
 */
export async function extractFacetRecords(
  input: FacetRecordsInput,
  nodes: readonly PluginNode[],
  facets: readonly Facet[],
): Promise<void> {
  const read = await facetTextsOver(input.snapshot, input, nodes, facets);
  // The texts were read for the first caller's plugins and facets: a set's
  // plugin tree is a function of the set, and the facets are the process's
  // one registry — anything else is a caller holding another tree.
  const ids = (fs: readonly Facet[]) => fs.map((f) => f.def.id).join("\n");
  if (ids(read.facets) !== ids(facets) || read.byDir.size !== nodes.length)
    throw new Error(
      "[plugin-tree] the facet records of this set were read for another plugin tree or facet list",
    );

  // Every node's data is parsed from its record's text, hit or fresh: one
  // spelling, so a fresh extraction and a stored one cannot differ by what
  // JSON drops (an `undefined` field, a Map) — and each tree parses its own
  // copy, so relating one never touches the other's data.
  for (const node of nodes) {
    const own = read.byDir.get(node.dir);
    if (own === undefined)
      throw new Error(
        `[plugin-tree] ${node.path} is not in the plugin tree its set's facet records were read for`,
      );
    for (const f of facets)
      setFacet(node, f.def, JSON.parse(own.get(f.def.id)!) as unknown);
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
