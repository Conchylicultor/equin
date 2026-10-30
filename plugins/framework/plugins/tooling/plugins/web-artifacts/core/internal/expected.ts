// The map-in-sync check's engine: recompute the EXACT import map the current
// tree would compose — the same planning code the pipeline runs (plan.ts), with
// `ensure` swapped from build-or-read to read-or-bail. Pure hashing plus store
// meta reads; never builds, never mutates the store. If any expected artifact
// (or the vendor set) is absent from the store, the deployed dist cannot have
// been composed from the current tree — reported as `missing-artifacts` rather
// than a URL diff, since the closure can't even be completed without the metas.

import { basename, join } from "node:path";
import { BUILDER_VERSION } from "../constants";
import { buildImportMap } from "../import-map";
import { hostWorkerSpecifier, type BrowserHostPlan } from "./browser-hosts";
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
import {
  hasArtifact,
  loadFingerprintCache,
  readArtifactMeta,
  saveFingerprintCache,
  type ArtifactMeta,
} from "./store";
import {
  readVendorSetMeta,
  resolveVendorSet,
  vendorSetDirName,
  vendorSetPath,
  type VendorSetMeta,
} from "./vendors";
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
  metas: ReadonlyMap<string, ArtifactMeta>;
  vendorSetHash: string;
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
    linked: [...linked.values()],
    vendorSetDir: vendorSetPath(opts.vendorSetHash),
  });
  return opts.hosts.map((h) => ({
    specifier: h.plan.specifier,
    dirName: h.dirName,
    workerSpecifier: hostWorkerSpecifier(h.plan.pluginPath),
    workerUrl: `/artifacts/${tree.dirName}/${workerLinkName(h.entry.pluginPath!, h.entry.kind)}/index.js`,
  }));
}

export type ExpectedComposition =
  | { kind: "computed"; imports: Record<string, string>; entryUrl: string }
  | { kind: "missing-artifacts"; missing: string[] };

/** The expected fleet's targets and metas, stopping at store misses. */
export async function planExpectedFleet(opts: {
  root: string;
  minify: boolean;
  /** Which registry + entry set to plan; defaults to the committed full registry. */
  source?: FleetSource;
}): Promise<{
  targets: PlannedTarget[];
  registryDirName: string;
  entryDirName: string;
  hosts: ExpectedHost[];
  metas: Map<string, ArtifactMeta>;
  missing: string[];
  builderSource: string;
}> {
  const pluginsRoot = join(opts.root, "plugins");
  const cache = loadFingerprintCache(basename(opts.root));
  const plan = await planFleet({
    root: opts.root,
    minify: opts.minify,
    cache,
    source: opts.source,
  });

  const metas = new Map<string, ArtifactMeta>();
  const missing: string[] = [];
  const read = (dirName: string): ArtifactMeta | null => {
    if (!hasArtifact(dirName)) {
      missing.push(dirName);
      return null;
    }
    const meta = readArtifactMeta(dirName);
    metas.set(dirName, meta);
    return meta;
  };

  for (const t of [...plan.webTargets, plan.entryTarget]) read(t.dirName);
  read(plan.registryTarget.dirName);
  const barrelTargets = await resolveBarrelClosure({
    pluginsRoot,
    identityHash: plan.identity.identityHash,
    cache,
    servedSpecs: servedSpecsOf(plan.webTargets),
    seedMetas: [...metas.values()],
    ensure: async (t) => read(t.dirName),
  });
  const pageTargets = [
    ...plan.webTargets,
    ...barrelTargets.values(),
    plan.entryTarget,
  ];

  // A host no stored build's recorded inputs describe (this tree hashes to
  // none of their addresses) is missing until a build of this tree stores one.
  // Its worker closure is planned exactly as the pipeline plans it.
  const hosts: ExpectedHost[] = [];
  const served = servedSpecsOf(pageTargets);
  for (const host of plan.hosts) {
    const { entry, added } = await planHostClosure({
      pluginsRoot,
      host,
      identityHash: plan.identity.identityHash,
      cache,
      servedSpecs: served,
      ensure: async (t) => read(t.dirName),
    });
    for (const s of servedSpecsOf(added)) served.add(s);
    if (host.dirName === null) missing.push(`browser host ${host.pluginPath}`);
    else if (read(host.dirName) !== null)
      hosts.push({ plan: host, dirName: host.dirName, entry, added });
  }
  // Persist the (pure, stat-keyed) fingerprint cache so repeated check runs
  // stay on the fast path even before the next build saves it.
  saveFingerprintCache(basename(opts.root), cache);

  return {
    targets: [...pageTargets, ...hosts.flatMap((h) => [h.entry, ...h.added])],
    registryDirName: plan.registryTarget.dirName,
    entryDirName: plan.entryTarget.dirName,
    hosts,
    metas,
    missing: [...missing].sort(),
    builderSource: plan.identity.sourceDigest,
  };
}

/** The exact import map + entry URL the current tree composes. */
export async function computeExpectedComposition(opts: {
  root: string;
  minify: boolean;
}): Promise<ExpectedComposition> {
  const fleet = await planExpectedFleet(opts);
  if (fleet.missing.length > 0) {
    return { kind: "missing-artifacts", missing: fleet.missing };
  }

  const requests = await collectVendorRequests({
    root: opts.root,
    pluginsRoot: join(opts.root, "plugins"),
    targets: fleet.targets,
    metaOf: (dirName) => fleet.metas.get(dirName)!,
  });
  const { setHash } = await resolveVendorSet({
    requests,
    minify: opts.minify,
    builderVersion: BUILDER_VERSION,
    builderSource: fleet.builderSource,
    root: opts.root,
  });
  const vendorMeta = readVendorSetMeta(setHash);
  if (vendorMeta === null) {
    return { kind: "missing-artifacts", missing: [vendorSetDirName(setHash)] };
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
  root: string;
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
    root: opts.root,
    pluginsRoot: join(opts.root, "plugins"),
    targets: fleet.targets,
    metaOf: (dirName) => fleet.metas.get(dirName)!,
  });
  const { setHash } = await resolveVendorSet({
    requests,
    minify: opts.minify,
    builderVersion: BUILDER_VERSION,
    builderSource: fleet.builderSource,
    root: opts.root,
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
