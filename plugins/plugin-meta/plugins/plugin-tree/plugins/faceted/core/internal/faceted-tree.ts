import type { SlotNaming } from "@plugins/framework/plugins/slot-declaration/core";
import { relative } from "path";
import type {
  RepoFiles,
  RepoSnapshot,
} from "@plugins/framework/plugins/tooling/core";
import {
  getFacet,
  setFacet,
  type EnrichContext,
  type Facet,
} from "@plugins/plugin-meta/plugins/facets/core";
import { loadFacets } from "@plugins/plugin-meta/plugins/facets/plugins/loader/core";
import {
  currentRecordStore,
  outsideFilesAt,
} from "@plugins/plugin-meta/plugins/plugin-records/core";
import { runWithFsSnapshot } from "@plugins/plugin-meta/plugins/parse-utils/core";
import {
  createTimeSlicer,
  yieldMacrotask,
} from "@plugins/packages/plugins/macrotask-yield/core";
import type {
  PluginNode,
  PluginTree,
} from "@plugins/plugin-meta/plugins/plugin-tree/core";
import { buildRecordedPluginTree } from "@plugins/plugin-meta/plugins/plugin-tree/plugins/structure-records/core";
import type { AppPath } from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import { buildFsSnapshot } from "./fs-snapshot";
import { extractFacetRecords } from "./facet-records";

/**
 * What makes a tree ENRICHED: each plugin's barrels as the build evaluated them
 * (the evaluated records, revived — `codegen`'s evaluation pass), and the
 * naming of the slots their contributions target. Applied by each facet's
 * `enrich`; see `EnrichContext` for why the two travel as one value.
 */
export interface TreeEnrichment {
  modulesOf(node: PluginNode): EnrichContext["imported"]["modules"];
  naming: SlotNaming;
}

export interface BuildFacetedTreeOptions {
  /**
   * The pass's file set — required, so the tree never lists the repo itself.
   * A SNAPSHOT (with blob ids — a build's, or a check run's `ctx.repo()`)
   * makes the facets plugin records: read from the process's record store,
   * extracted only where they missed.
   */
  repo: RepoFiles;
  /** Enrich the facets with the evaluated barrels (see {@link TreeEnrichment}). */
  enrich?: TreeEnrichment;
}

function isSnapshot(repo: RepoFiles): repo is RepoSnapshot {
  return typeof (repo as Partial<RepoSnapshot>).blobOf === "function";
}

/**
 * The plugin tree under `pluginsRoot` with every facet extracted (and, with
 * `enrich`, enriched), then related: `buildRecordedPluginTree`'s structure plus the
 * facet extractors.
 *
 * Build tooling: it loads every facet extractor (`facets/loader`), and through
 * them the parsers and codegen. It runs in the CLI and the check runner, never
 * in a serving backend — a backend reads the faceted tree as data, kept by
 * this plugin's faceted-tree worker (`openFacetedIndex`, `plugin-tree/server`'s
 * `getFacetsTreeCached`).
 */
export async function buildFacetedPluginTree(
  pluginsRoot: AppPath,
  opts: BuildFacetedTreeOptions,
): Promise<PluginTree> {
  const tree = await buildRecordedPluginTree(pluginsRoot, { repo: opts.repo });
  const { repo } = tree;
  const facets = await loadFacets();
  tree.facets = facets;
  const nodes = [...tree.byDir.values()];

  // Step 1: extract. From a snapshot, facets are plugin records (see
  // `facet-records.ts`): only the plugins whose files changed are read.
  // Without one there is nothing to key a record by, so every plugin is read
  // and extracted — through the same JSON spelling a record has, so both
  // paths hand `relate` and `renderDoc` the same values.
  if (isSnapshot(repo)) {
    await extractFacetRecords(
      {
        snapshot: repo,
        store: currentRecordStore(),
        readOutside: outsideFilesAt(repo.root),
      },
      nodes,
      facets,
    );
  } else {
    await extractEveryFacet(repo, nodes, facets);
  }

  // Step 2: enrich with the evaluated barrels (the enriched tree only). Never
  // a record: the naming is the whole tree's.
  const enrich = opts.enrich;
  if (enrich) {
    for (const node of nodes) {
      const modules = enrich.modulesOf(node);
      for (const facet of facets) {
        if (!facet.enrich) continue;
        setFacet(
          node,
          facet.def,
          facet.enrich(getFacet(node, facet.def), {
            dir: node.dir,
            pluginId: node.id,
            imported: { modules, naming: enrich.naming },
          }),
        );
      }
    }
  }

  // Step 3: facet relate, over every plugin's data in memory.
  await relateFacets(tree);

  return tree;
}

/**
 * Every facet's `relate` over the tree's data, in place. Yields between facets
 * so the residual block is one facet's relate, not all of them summed.
 */
export async function relateFacets(tree: PluginTree): Promise<void> {
  for (const facet of tree.facets) {
    if (!facet.relate) continue;
    facet.relate({ tree });
    await yieldMacrotask();
  }
}

/**
 * Every facet of every plugin, extracted from a file set with no blob ids (so
 * no record can be keyed): the files are read once, in memory, and each
 * result is spelled as JSON exactly as a record is.
 */
async function extractEveryFacet(
  repo: RepoFiles,
  nodes: readonly PluginNode[],
  facets: readonly Facet[],
): Promise<void> {
  const fs = await buildFsSnapshot(
    repo,
    nodes.map((n) => n.dir),
  );
  // The extract loop shares its thread with whoever else is running (a check
  // pass runs ~100 checks on it), so it yields a macrotask after ~10 ms of work
  // rather than per node count: one node's facets can cost far more than
  // another's. The reads are in-memory, so this bounds CPU, not I/O.
  const slice = createTimeSlicer();
  const data = new Map<PluginNode, Map<string, unknown>>();
  for (const node of nodes) {
    const byFacet = new Map<string, unknown>();
    for (const facet of facets) {
      byFacet.set(
        facet.def.id,
        runWithFsSnapshot(fs, () =>
          facet.extract({
            dir: node.dir,
            relDir: relative(repo.root, node.dir),
            pluginId: node.id,
            fs,
          }),
        ),
      );
      await slice();
    }
    data.set(node, byFacet);
  }
  for (const facet of facets) {
    if (!facet.extractBatch) continue;
    await facet.extractBatch.run({
      root: repo.root,
      fs,
      plugins: nodes.map((node) => ({
        dir: node.dir,
        data: data.get(node)!.get(facet.def.id),
      })),
    });
  }
  for (const node of nodes) {
    for (const facet of facets) {
      setFacet(
        node,
        facet.def,
        JSON.parse(
          JSON.stringify(data.get(node)!.get(facet.def.id)),
        ) as unknown,
      );
    }
  }
}
