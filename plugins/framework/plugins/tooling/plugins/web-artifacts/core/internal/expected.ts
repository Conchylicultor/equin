// The map-in-sync check's engine: recompute the EXACT import map the current
// tree would compose — the same planning code the pipeline runs (plan.ts), with
// `ensure` swapped from build-or-read to read-or-bail. Pure hashing plus reads
// from a `PlanReads` source — the store (`storeReads`), or one deployed dist's
// own record (`deployedReads`, what map-in-sync uses); never builds, never
// mutates the store. If any expected artifact (or the vendor set) is absent
// from the source, the deployed dist cannot have been composed from the
// current tree — reported as `missing-artifacts` rather than a URL diff, since
// the closure can't even be completed without the metas.

import { joinAppPath } from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import { BUILDER_VERSION } from "../constants";
import { buildImportMap } from "../import-map";
import { BROWSER_HOST_SPECIFIER_PREFIX } from "@plugins/framework/plugins/import-map-names/core";
import {
  hostWorkerSpecifier,
  readHostRecord,
  storedHostRecords,
  type BrowserHostPlan,
  type HostRecordSource,
} from "./browser-hosts";
import type { OwnSources } from "./own-files";
import type { RepoSnapshot } from "@plugins/framework/plugins/tooling/core";
import {
  artifactUrl,
  collectVendorRequests,
  composeMapEntries,
  planFleet,
  planHostClosure,
  resolveBarrelClosure,
  servedSpecsOf,
  workerClosure,
  type ComposedHost,
  type FleetSource,
  type PlannedTarget,
} from "./plan";
import { createSemaphore } from "@plugins/packages/plugins/semaphore/core";
import {
  hasArtifact,
  loadGlobPatternMemo,
  readPublishedArtifactMeta,
  type GlobPatternMemo,
  type ArtifactEdges,
} from "./store";
import {
  readVendorSetMeta,
  resolveVendorSet,
  vendorSetDirName,
  vendorSetPath,
  type VendorSetMeta,
} from "./vendors";
import { hostSnapshotLinks, type HostSnapshotLink } from "./host-snapshots";
import {
  workerLinkedDirName,
  workerLinkName,
  workerTreeOf,
} from "./worker-link";

/** A host as planned: its module's store dir and its worker closure. */
export interface ExpectedHost {
  plan: BrowserHostPlan;
  dirName: string;
  entry: PlannedTarget;
  added: PlannedTarget[];
}

/**
 * The hosts as the import map names them: each host module, and its worker
 * entry inside the worker tree the pipeline links (`worker-link.ts`) — the
 * same pure tree name, computed from the closure's artifact addresses.
 */
export function composedHostsOf(opts: {
  hosts: readonly ExpectedHost[];
  targets: readonly PlannedTarget[];
  metas: ReadonlyMap<string, ArtifactEdges>;
  vendorSetHash: string;
  /** The hosts' snapshots the tree links (`host-snapshots.ts`'s `hostSnapshotLinks`). */
  snapshotLinks: readonly HostSnapshotLink[];
}): ComposedHost[] {
  if (opts.hosts.length === 0) return [];
  const linked = new Map<string, { linkName: string; linkedDirName: string }>();
  for (const host of opts.hosts) {
    for (const t of workerClosure({
      entry: host.entry,
      targets: opts.targets,
      metaOf: (dirName) => opts.metas.get(dirName)!,
    })) {
      linked.set(t.dirName, {
        linkName: workerLinkName(t.pluginPath!, t.kind),
        linkedDirName: workerLinkedDirName(t.dirName),
      });
    }
  }
  const tree = workerTreeOf({
    linked: [...linked.values(), ...opts.snapshotLinks],
    vendorSetDir: vendorSetPath(opts.vendorSetHash),
  });
  return opts.hosts.map((h) => ({
    specifier: h.plan.specifier,
    dirName: h.dirName,
    workerSpecifier: hostWorkerSpecifier(h.plan.pluginPath),
    workerUrl: `/artifacts/${tree.dirName}/${workerLinkName(h.entry.pluginPath!, h.entry.kind)}/index.js`,
  }));
}

/** How a plan obtains a published artifact's edges: `null` when the source lacks it. */
export type EdgesReader = (dirName: string) => Promise<ArtifactEdges | null>;

/**
 * Where a plan reads what the tree's addresses hold: each address's edges
 * (`null` ⇒ missing), and which stored builds of each browser host to try.
 */
export interface PlanReads {
  edges: EdgesReader;
  hostRecords: HostRecordSource;
}

/** The store's own answers: each address's `meta.json`, every stored host build. */
export const storeReads: PlanReads = {
  edges: readPublishedArtifactMeta,
  hostRecords: storedHostRecords,
};

/**
 * The answers ONE deployed dist gives: the edges it recorded for exactly the
 * addresses it composed (`DIST_EDGES_FILE`), and the one build of each host
 * its import map serves. Nothing else is read — not the store.
 *
 * Exact for the question `map-in-sync` asks (is this dist the composition of
 * the tree?). An address is content: a planned address the dist does not name
 * is one it did not compose, so the dist is out of sync whatever the shared
 * store holds — reading the store for it (as this once did, "for the
 * re-addressed ones only") made the check's work and verdict depend on what
 * every other checkout on the machine had built: a builder-identity change
 * re-addresses the whole fleet, ~2.5k store reads. A host build other than
 * the served one names another address too, so only the served one is tried.
 */
export function deployedReads(dist: {
  edges: ReadonlyMap<string, ArtifactEdges>;
  /** The deployed import map's `imports`. */
  imports: Readonly<Record<string, string>>;
}): PlanReads {
  return {
    edges: async (dirName) => dist.edges.get(dirName) ?? null,
    hostRecords: (pluginPath) => {
      const url = dist.imports[`${BROWSER_HOST_SPECIFIER_PREFIX}${pluginPath}`];
      const dirName =
        url === undefined
          ? undefined
          : /^\/artifacts\/([^/]+)\//.exec(url)?.[1];
      if (dirName === undefined) return [];
      const record = readHostRecord(pluginPath, dirName);
      return record === null ? [] : [record];
    },
  };
}

export type ExpectedComposition =
  | { kind: "computed"; imports: Record<string, string>; entryUrl: string }
  | { kind: "missing-artifacts"; missing: string[] };

/** The expected fleet's targets and metas, stopping at store misses. */
export async function planExpectedFleet(opts: {
  /** The pass's file set (a check run's `ctx.repo()`): the own-file sources are read off it. */
  repo: RepoSnapshot;
  minify: boolean;
  /** Which registry + entry set to plan; defaults to the committed full registry. */
  source?: FleetSource;
  /** Where the plan reads edges and host builds; defaults to the store ({@link storeReads}). */
  reads?: PlanReads;
  /** The glob-pattern memo the plan reads and persists; defaults to the store's. */
  globs?: GlobPatternMemo;
}): Promise<{
  targets: PlannedTarget[];
  registryDirName: string;
  entryDirName: string;
  hosts: ExpectedHost[];
  metas: Map<string, ArtifactEdges>;
  missing: string[];
  builderSource: string;
  identityHash: string;
}> {
  const { root } = opts.repo;
  const pluginsRoot = joinAppPath(root, "plugins");
  const sources: OwnSources = {
    snapshot: opts.repo,
    globs: opts.globs ?? loadGlobPatternMemo(),
  };
  const reads = opts.reads ?? storeReads;
  const plan = await planFleet({
    root,
    minify: opts.minify,
    sources,
    source: opts.source,
    hostRecords: reads.hostRecords,
  });

  const readEdges = reads.edges;
  const metas = new Map<string, ArtifactEdges>();
  const missing: string[] = [];
  // A store read is one non-blocking `meta.json` read (absent ⇒ missing):
  // this runs on the check runner's shared thread. Bounded, so a plan never
  // holds thousands of descriptors open at once.
  const gate = createSemaphore(16);
  const record = (dirName: string, meta: ArtifactEdges | null) => {
    if (meta === null) missing.push(dirName);
    else metas.set(dirName, meta);
    return meta;
  };
  const read = async (dirName: string): Promise<ArtifactEdges | null> =>
    record(dirName, await gate.run(() => readEdges(dirName)));

  // The seeds are read concurrently, then recorded in plan order, so the
  // closure below sees them exactly as a sequential read would.
  const seeds = [...plan.webTargets, plan.entryTarget, plan.registryTarget].map(
    (t) => t.dirName,
  );
  const seedMetas = await Promise.all(
    seeds.map((dirName) => gate.run(() => readEdges(dirName))),
  );
  seeds.forEach((dirName, i) => record(dirName, seedMetas[i]!));
  const barrelTargets = await resolveBarrelClosure({
    pluginsRoot,
    identityHash: plan.identity.identityHash,
    sources,
    servedSpecs: servedSpecsOf(plan.webTargets),
    seedMetas: [...metas.values()],
    ensure: (t) => read(t.dirName),
  });
  const pageTargets = [
    ...plan.webTargets,
    ...barrelTargets.values(),
    plan.entryTarget,
  ];

  // A host no tried build's recorded inputs describe (this tree hashes to
  // none of their addresses) is missing until a build of this tree stores one.
  // A matched record was read out of its store dir, so the build is there.
  // Its worker closure is planned exactly as the pipeline plans it.
  const hosts: ExpectedHost[] = [];
  const served = servedSpecsOf(pageTargets);
  for (const host of plan.hosts) {
    const { entry, added } = await planHostClosure({
      pluginsRoot,
      host,
      identityHash: plan.identity.identityHash,
      sources,
      servedSpecs: served,
      ensure: (t) => read(t.dirName),
    });
    for (const s of servedSpecsOf(added)) served.add(s);
    if (host.dirName === null) missing.push(`browser host ${host.pluginPath}`);
    else hosts.push({ plan: host, dirName: host.dirName, entry, added });
  }
  // Persist the glob patterns this plan read, so a later run reads none.
  sources.globs.save();

  return {
    targets: [...pageTargets, ...hosts.flatMap((h) => [h.entry, ...h.added])],
    registryDirName: plan.registryTarget.dirName,
    entryDirName: plan.entryTarget.dirName,
    hosts,
    metas,
    missing: [...missing].sort(),
    builderSource: plan.identity.sourceDigest,
    identityHash: plan.identity.identityHash,
  };
}

/** The exact import map + entry URL the current tree composes. */
export async function computeExpectedComposition(opts: {
  /** The pass's file set (a check run's `ctx.repo()`, a pass root's snapshot). */
  repo: RepoSnapshot;
  minify: boolean;
  /** Where the plan reads edges and host builds; defaults to the store. */
  reads?: PlanReads;
}): Promise<ExpectedComposition> {
  const fleet = await planExpectedFleet(opts);
  if (fleet.missing.length > 0) {
    return { kind: "missing-artifacts", missing: fleet.missing };
  }

  const requests = await collectVendorRequests({
    root: opts.repo.root,
    pluginsRoot: joinAppPath(opts.repo.root, "plugins"),
    targets: fleet.targets,
    metaOf: (dirName) => fleet.metas.get(dirName)!,
  });
  const { setHash } = await resolveVendorSet({
    requests,
    minify: opts.minify,
    builderVersion: BUILDER_VERSION,
    builderSource: fleet.builderSource,
    root: opts.repo.root,
  });
  const vendorMeta = readVendorSetMeta(setHash);
  if (vendorMeta === null) {
    return { kind: "missing-artifacts", missing: [vendorSetDirName(setHash)] };
  }

  const snapshotLinks = await hostSnapshotLinks({
    repo: opts.repo,
    hosts: fleet.hosts.map((h) => ({
      pluginPath: h.plan.pluginPath,
      entry: h.entry,
    })),
    targets: fleet.targets,
    metaOf: (dirName) => fleet.metas.get(dirName)!,
  });
  // The tree links each snapshot by name: one the store lacks is a dangling
  // link, not a composition this tree has.
  const missingSnapshots = snapshotLinks
    .filter((l) => !hasArtifact(l.linkedDirName))
    .map((l) => l.linkedDirName);
  if (missingSnapshots.length > 0) {
    return { kind: "missing-artifacts", missing: missingSnapshots };
  }
  const mapEntries = composeMapEntries({
    targets: fleet.targets,
    registryDirName: fleet.registryDirName,
    vendorMeta,
    hosts: composedHostsOf({
      hosts: fleet.hosts,
      targets: fleet.targets,
      metas: fleet.metas,
      vendorSetHash: vendorMeta.setHash,
      snapshotLinks,
    }),
  });
  return {
    kind: "computed",
    imports: buildImportMap(mapEntries).imports,
    entryUrl: artifactUrl(fleet.entryDirName),
  };
}

/**
 * The stored vendor-set meta of the current tree's FULL fleet — the set a
 * composition dist reuses (`WebArtifactsPipelineOptions.vendors`). Pure hashing
 * plus store reads; throws when any fleet artifact or the set itself is absent,
 * which means the full fleet has not been built from this tree yet.
 */
export async function readFleetVendorMeta(opts: {
  /** The pass's file set (a check run's `ctx.repo()`, a pass root's snapshot). */
  repo: RepoSnapshot;
  minify: boolean;
}): Promise<VendorSetMeta> {
  const fleet = await planExpectedFleet(opts);
  if (fleet.missing.length > 0) {
    const shown = fleet.missing.slice(0, 8).join(", ");
    throw new Error(
      `fleet vendor set: ${fleet.missing.length} fleet artifact(s) missing from the store ` +
        `(build the full fleet first): ${shown}${fleet.missing.length > 8 ? ", …" : ""}`,
    );
  }
  const requests = await collectVendorRequests({
    root: opts.repo.root,
    pluginsRoot: joinAppPath(opts.repo.root, "plugins"),
    targets: fleet.targets,
    metaOf: (dirName) => fleet.metas.get(dirName)!,
  });
  const { setHash } = await resolveVendorSet({
    requests,
    minify: opts.minify,
    builderVersion: BUILDER_VERSION,
    builderSource: fleet.builderSource,
    root: opts.repo.root,
  });
  const meta = readVendorSetMeta(setHash);
  if (meta === null) {
    throw new Error(
      `fleet vendor set: ${vendorSetDirName(setHash)} missing from the store ` +
        `(build the full fleet first).`,
    );
  }
  return meta;
}
