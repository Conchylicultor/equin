import type { RepoSnapshot } from "@plugins/framework/plugins/tooling/core";
import {
  loadFacetSources,
  setFacet,
  type Facet,
} from "@plugins/plugin-meta/plugins/facets/core";
import {
  buildModuleGraph,
  recordKey,
  type RecordStore,
} from "@plugins/plugin-meta/plugins/plugin-records/core";
import { runWithFsSnapshot } from "@plugins/plugin-meta/plugins/parse-utils/core";
import { createTimeSlicer } from "@plugins/packages/plugins/macrotask-yield/core";
import { buildFsSnapshot, pluginFilesManifest } from "./fs-snapshot";
import type { PluginNode } from "./plugin-tree";

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

/** The module whose code shapes every extraction (what the snapshot holds, how it is read). */
const HARNESS_MODULES = [
  "plugins/plugin-meta/plugins/plugin-tree/core/internal/plugin-tree.ts",
  "plugins/plugin-meta/plugins/plugin-tree/core/internal/facet-records.ts",
];

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
  const graph = await buildModuleGraph(input, [
    ...HARNESS_MODULES,
    ...sources.values(),
  ]);
  const harness = HARNESS_MODULES.map((m) => graph.keyOf(m));
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
 * Fill every node's facets from the records, extracting (and storing) only
 * the ones that missed.
 */
export async function extractFacetRecords(
  input: FacetRecordsInput,
  nodes: readonly PluginNode[],
  facets: readonly Facet[],
): Promise<void> {
  const { snapshot, store } = input;
  const identities = await facetIdentities(input, facets);
  // A batch input's blob is part of its facet's key.
  const batchInputs = new Map<string, string[]>();
  for (const f of facets) {
    if (!f.extractBatch) continue;
    batchInputs.set(
      f.def.id,
      f.extractBatch.inputs.map((p) => `${p}\t${snapshot.blobOf(p)}`),
    );
  }

  const keyOf = new Map<PluginNode, Map<string, string>>();
  const wanted: string[] = [];
  for (const node of nodes) {
    const relDir = relDirOf(snapshot, node);
    const files = pluginFilesManifest(snapshot, node.dir).sort();
    const own = recordKey("own", relDir, node.id, ...files);
    const perFacet = new Map<string, string>();
    for (const f of facets) {
      const k = recordKey(
        identities.get(f.def.id)!,
        own,
        ...(batchInputs.get(f.def.id) ?? []),
      );
      perFacet.set(f.def.id, k);
      wanted.push(k);
    }
    keyOf.set(node, perFacet);
  }
  const hits = store.getMany("facet", wanted);

  // Nodes with at least one missed facet: the only plugins whose files are read.
  const missed = nodes.filter((n) =>
    [...keyOf.get(n)!.values()].some((k) => !hits.has(k)),
  );
  const fresh = new Map<string, string>();
  if (missed.length > 0) {
    const fs = await buildFsSnapshot(
      snapshot,
      missed.map((n) => n.dir),
      { strict: "the files of the plugins whose records are being made" },
    );
    const extracted = new Map<PluginNode, Map<string, unknown>>();
    const slice = createTimeSlicer();
    for (const node of missed) {
      const data = new Map<string, unknown>();
      for (const f of facets) {
        if (hits.has(keyOf.get(node)!.get(f.def.id)!)) continue;
        data.set(
          f.def.id,
          runWithFsSnapshot(fs, () =>
            f.extract({
              dir: node.dir,
              relDir: relDirOf(snapshot, node),
              pluginId: node.id,
              fs,
            }),
          ),
        );
        await slice();
      }
      extracted.set(node, data);
    }
    for (const f of facets) {
      if (!f.extractBatch) continue;
      const plugins = missed.flatMap((node) => {
        const data = extracted.get(node)!.get(f.def.id);
        return data === undefined ? [] : [{ dir: node.dir, data }];
      });
      if (plugins.length > 0)
        await f.extractBatch.run({ root: snapshot.root, fs, plugins });
    }
    for (const [node, data] of extracted) {
      for (const [facetId, value] of data) {
        fresh.set(keyOf.get(node)!.get(facetId)!, JSON.stringify(value));
      }
    }
    store.putMany("facet", [...fresh]);
  }

  // Every node's data is parsed from its record's text, hit or fresh: one
  // spelling, so a fresh extraction and a stored one cannot differ by what
  // JSON drops (an `undefined` field, a Map).
  for (const node of nodes) {
    for (const f of facets) {
      const k = keyOf.get(node)!.get(f.def.id)!;
      const text = hits.get(k) ?? fresh.get(k);
      if (text === undefined)
        throw new Error(
          `[plugin-tree] no record for facet "${f.def.id}" of ${node.path}`,
        );
      setFacet(node, f.def, JSON.parse(text) as unknown);
    }
  }
}

function relDirOf(snapshot: RepoSnapshot, node: PluginNode): string {
  const root = snapshot.root.endsWith("/")
    ? snapshot.root
    : `${snapshot.root}/`;
  if (!node.dir.startsWith(root))
    throw new Error(`[plugin-tree] ${node.dir} is not under ${snapshot.root}`);
  return node.dir.slice(root.length);
}
