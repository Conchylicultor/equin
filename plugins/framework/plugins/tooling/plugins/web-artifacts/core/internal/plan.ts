// Shared fleet planning — the pure "what artifacts does the CURRENT tree
// compose, at which content-addressed store names" computation, factored out of
// the build pipeline so the `web-artifacts:map-in-sync` check recomputes the
// EXACT same expected composition (targets, barrel closure, vendor requests,
// import-map entries) without ever building. The two consumers differ only in
// how a target's meta is obtained: the pipeline builds-or-reads, the check
// reads-or-bails — injected via `ensure`.

import {
  BROWSER_HOST_FILE,
  planBrowserHosts,
  type BrowserHostPlan,
} from "./browser-hosts";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  BROWSER_HOST_ENTRY_KIND,
  FORCED_VENDOR_SPECS,
  isBareSpecifier,
  isBrowserUnreachableDynamic,
  WORKER_ONLY_KINDS,
} from "../constants";
import { MAIN_COMPOSITION_ID } from "@plugins/infra/plugins/namespace/core";
import { COMPOSITION_REGISTRY_SPECIFIER } from "../composition-modules";
import { computeInputsHash, sha256Hex } from "../hash";
import type { ImportMapEntry } from "../import-map";
import {
  cobuildHostOf,
  cobuiltFoldersOf,
  type ArtifactKind,
} from "../own-roots";
import { computeBuilderIdentity, type BuilderIdentity } from "./identity";
import { ownHashFor } from "./own-files";
import {
  allStaticImports,
  artifactDirName,
  hasArtifact,
  type ArtifactMeta,
  type FingerprintCache,
} from "./store";
import {
  coEntryFileName,
  type ArtifactBuildTarget,
  type CoEntry,
} from "./vite-builder";
import {
  vendorSetDirName,
  type VendorSetMeta,
  type VendorSpecRequest,
} from "./vendors";

export const WEB_CORE_REL = "plugins/framework/plugins/web-core";
export const WEB_SDK_CORE_REL = "plugins/framework/plugins/web-sdk/core";

export interface RegistryEntryRecord {
  pluginPath: string;
  id: string;
  dependsOn: string[];
}

/**
 * What the fleet is planned FROM: the web registry module (entries + file) and
 * the deferred-tier set. The default source is the committed full registry;
 * a composition dist injects its gitignored per-name filtered registry instead.
 * Everything downstream of the entry list is a pure function of this source.
 */
export interface FleetSource {
  webEntries: RegistryEntryRecord[];
  deferredPaths: ReadonlySet<string>;
  /** The registry module the registry artifact is built from (absolute path). */
  registryFile: string;
  /**
   * Store slug for the registry artifact. The `@composition-web-registry`
   * import-map alias stays FIXED across sources (it is the seam the entry
   * artifact imports — same entry, different registry artifact = different
   * composition); only the store name carries the source identity.
   */
  registrySlug: string;
}

/** The committed full registry — the source every plain build plans from. */
export async function defaultFleetSource(root: string): Promise<FleetSource> {
  const registryFile = join(root, WEB_SDK_CORE_REL, "web.generated.ts");
  const { webEntries } = (await import(registryFile)) as {
    webEntries: RegistryEntryRecord[];
  };
  const { DEFERRED_PLUGIN_PATHS } = (await import(
    join(root, WEB_SDK_CORE_REL, "web-tiers.generated.ts")
  )) as { DEFERRED_PLUGIN_PATHS: ReadonlySet<string> };
  return {
    webEntries,
    deferredPaths: DEFERRED_PLUGIN_PATHS,
    registryFile,
    registrySlug: "composition-web-registry",
  };
}

/**
 * The fleet source of one served composition: the gitignored per-name filtered
 * web registry (emitted by codegen's `generateCompositionRegistry({ name })`)
 * with the FULL deferred-tier set — eager-seed selection is a membership test
 * (filtered targets minus deferred paths), so a superset is exact on the
 * filtered entries and needs no per-composition tier codegen.
 *
 * The MAIN composition is not a special case, it is the base case: its registry
 * IS the committed `web.generated.ts`, so this hands back `defaultFleetSource`.
 * Nothing else can be true — `generateCompositionRegistry` refuses to write a
 * `web.composition.<main>.generated.ts`, because a second spelling of the
 * committed registry is the file that used to reconfigure main by merely
 * existing. The same equality is stated for the server registry in codegen's
 * `compositionRegistryFileName`.
 *
 * Consequently `registrySlug` keeps its `web-registry-<composition>` form for
 * every other composition (the artifact is content-addressed and dedups across
 * checkouts, so it is keyed by composition, never by namespace) while main keeps
 * the `composition-web-registry` slug it has always had — which is what makes
 * a plain `build` and an explicit main-composition build produce the same artifact.
 */
export async function compositionFleetSource(opts: {
  root: string;
  name: string;
}): Promise<FleetSource> {
  if (opts.name === MAIN_COMPOSITION_ID) return defaultFleetSource(opts.root);
  const registryFile = join(
    opts.root,
    WEB_SDK_CORE_REL,
    `web.composition.${opts.name}.generated.ts`,
  );
  if (!existsSync(registryFile)) {
    throw new Error(
      `composition fleet source: ${registryFile} does not exist — emit it first ` +
        `via generateCompositionRegistry({ name: "${opts.name}" }).`,
    );
  }
  const { webEntries } = (await import(registryFile)) as {
    webEntries: RegistryEntryRecord[];
  };
  const { DEFERRED_PLUGIN_PATHS } = (await import(
    join(opts.root, WEB_SDK_CORE_REL, "web-tiers.generated.ts")
  )) as { DEFERRED_PLUGIN_PATHS: ReadonlySet<string> };
  return {
    webEntries,
    deferredPaths: DEFERRED_PLUGIN_PATHS,
    registryFile,
    registrySlug: `web-registry-${opts.name}`,
  };
}

export interface PlannedTarget extends ArtifactBuildTarget {
  needsBuild: boolean;
}

export interface RegistryTargetPlan {
  dirName: string;
  inputsHash: string;
  registryFile: string;
  needsBuild: boolean;
}

export interface FleetPlan {
  webEntries: RegistryEntryRecord[];
  /** The fleet's browser hosts (`./browser-hosts.ts`). */
  hosts: BrowserHostPlan[];
  deferredPaths: ReadonlySet<string>;
  identity: BuilderIdentity;
  webTargets: PlannedTarget[];
  entryTarget: PlannedTarget;
  registryTarget: RegistryTargetPlan;
  staleWeb: number;
}

export function pluginIdOf(pluginPath: string): string {
  return pluginPath.split("/plugins/").join(".");
}

export function artifactUrl(dirName: string): string {
  return `/artifacts/${dirName}/index.js`;
}

/**
 * The co-built entries a `kind` artifact of `pluginPath` carries: one per
 * co-built folder (`COBUILT_FOLDERS`) whose barrel exists. Derived from the
 * same files the artifact's address hashes (a host kind inlines its co-built
 * folders), so adding or removing one re-addresses the artifact.
 */
export function coEntriesFor(
  kind: ArtifactKind,
  pluginPath: string,
  pluginDir: string,
): CoEntry[] {
  return cobuiltFoldersOf(kind).flatMap((folder) => {
    const entryFile = join(pluginDir, folder, "index.ts");
    return existsSync(entryFile)
      ? [{ folder, entryFile, specifier: `@plugins/${pluginPath}/${folder}` }]
      : [];
  });
}

/** Every import-map specifier `targets` serve: each primary one plus its co-entries'. */
export function servedSpecsOf(
  targets: readonly ArtifactBuildTarget[],
): Set<string | null> {
  const specs = new Set<string | null>();
  for (const t of targets) {
    specs.add(t.specifier);
    for (const e of t.coEntries) specs.add(e.specifier);
  }
  return specs;
}

/**
 * The eager-tier web targets: the source's (possibly filtered) entries minus
 * the deferred paths. A pure membership test, so a composition source passing
 * the full deferred set gets the exact eager subset of ITS entries.
 */
export function eagerWebTargets(
  webTargets: PlannedTarget[],
  deferredPaths: ReadonlySet<string>,
): PlannedTarget[] {
  return webTargets.filter(
    (t) => t.pluginPath !== null && !deferredPaths.has(t.pluginPath),
  );
}

/**
 * Plan the base fleet (web entries + entry + registry) for the current tree:
 * pure hash computation over the plugins' own files (via the caller's
 * fingerprint cache) plus a store-existence probe per target. No builds, no
 * store writes — the caller owns cache persistence and store mutation.
 */
export async function planFleet(opts: {
  root: string;
  minify: boolean;
  cache: FingerprintCache;
  /** Which registry + entry set to plan; defaults to the committed full registry. */
  source?: FleetSource;
}): Promise<FleetPlan> {
  const { root, cache } = opts;
  const pluginsRoot = join(root, "plugins");
  const webSrcDir = join(root, WEB_CORE_REL, "web");

  const source = opts.source ?? (await defaultFleetSource(root));
  const { webEntries, registryFile } = source;

  const identity = await computeBuilderIdentity({
    repoRoot: root,
    pluginsRoot,
    minify: opts.minify,
  });

  const target = async (
    kind: ArtifactKind,
    pluginPath: string | null,
    entryFile: string,
    specifier: string | null,
  ): Promise<PlannedTarget> => {
    const slug = pluginPath ? pluginIdOf(pluginPath) : "web-core";
    const pluginDir = pluginPath ? join(pluginsRoot, pluginPath) : webSrcDir;
    const { ownHash, globRoots } = await ownHashFor({
      cacheKey: `${pluginPath ?? "__entry"}|${kind}`,
      pluginDir,
      kind,
      cache,
      repoRoot: root,
    });
    const inputsHash = computeInputsHash({
      ownHash,
      kind,
      identityHash: identity.identityHash,
    });
    const dirName = artifactDirName(slug, kind, inputsHash);
    return {
      dirName,
      kind,
      pluginPath,
      specifier,
      entryFile,
      inputsHash,
      globRoots,
      coEntries: pluginPath ? coEntriesFor(kind, pluginPath, pluginDir) : [],
      needsBuild: !hasArtifact(dirName),
    };
  };

  // Bounded by `own-files.ts`'s shared IO gate internally (`ownHashFor` →
  // `withIoSlot`), so firing every plugin's target build concurrently here is
  // safe — `Promise.all` preserves `webEntries`' order regardless of
  // resolution order, so target identity/dirName assignment is unchanged.
  const webTargets = await Promise.all(
    webEntries.map((e) =>
      target(
        "web",
        e.pluginPath,
        join(pluginsRoot, e.pluginPath, "web", "index.ts"),
        `@plugins/${e.pluginPath}/web`,
      ),
    ),
  );
  const entryTarget = await target(
    "entry",
    null,
    join(webSrcDir, "main.tsx"),
    null,
  );

  // The registry artifact is the one composition module, addressed by its source.
  const registrySource = await readFile(registryFile, "utf8");
  const registryInputsHash = computeInputsHash({
    ownHash: sha256Hex(registrySource),
    kind: "registry",
    identityHash: identity.identityHash,
  });
  const registryTarget: RegistryTargetPlan = {
    dirName: artifactDirName(
      source.registrySlug,
      "registry",
      registryInputsHash,
    ),
    inputsHash: registryInputsHash,
    registryFile,
    needsBuild: !hasArtifact(
      artifactDirName(source.registrySlug, "registry", registryInputsHash),
    ),
  };

  return {
    webEntries,
    hosts: planBrowserHosts({
      root,
      pluginPaths: webEntries.map((e) => e.pluginPath),
      identityHash: identity.identityHash,
    }),
    deferredPaths: source.deferredPaths,
    identity,
    webTargets,
    entryTarget,
    registryTarget,
    staleWeb: webTargets.filter((t) => t.needsBuild).length,
  };
}

/**
 * The specifiers of one emitted artifact that extend the barrel closure: every
 * static import (a miss breaks module evaluation) plus every dynamic import
 * except the kinds declared browser-unreachable
 * (`BROWSER_UNREACHABLE_DYNAMIC_KINDS`). A mapped dynamic barrel is the
 * import-map twin of the monolith's lazy chunk — the Layout Lab fixture
 * registries and the icon picker's icon map are real browser loads, and
 * leaving dynamic edges out of the closure broke both.
 */
export function closureSpecsOf(meta: ArtifactMeta): string[] {
  return [
    ...allStaticImports(meta),
    ...meta.dynamicImports.filter((s) => !isBrowserUnreachableDynamic(s)),
  ];
}

/**
 * Folder-barrel closure: any `@plugins/<path>/<folder>` the EMITTED modules
 * import (core barrels, …), iterated to a fixed point (core barrels
 * import other cores). Derived from emitted imports — post-tree-shaking and
 * type-stripped, so `import type` edges never force an artifact. Edges are
 * `closureSpecsOf`: statics always, dynamics unless declared
 * browser-unreachable (leaf folders: collected-dir registries' loaders that
 * only Bun-side tooling runs).
 *
 * A co-built folder (`COBUILT_FOLDERS`: `@plugins/<p>/exhibits`) is never an
 * artifact of its own: its specifier resolves to the plugin's HOST-kind
 * artifact (`web`), planned here when the fleet does not already carry it — a
 * plugin reached only through a registry's dynamic import still gets its
 * exhibits served from its web artifact. A co-built folder whose plugin has no
 * host barrel throws: there is nothing to co-build it into.
 *
 * `servedSpecs` is every specifier the seed targets already serve, co-entries
 * included (`servedSpecsOf`).
 *
 * `ensure` obtains a wave target's meta: the pipeline builds-or-reads; the
 * check reads-or-returns-null, which halts expansion through that node (the
 * missing artifact is the caller's verdict).
 */
export async function resolveBarrelClosure(opts: {
  pluginsRoot: string;
  identityHash: string;
  cache: FingerprintCache;
  servedSpecs: ReadonlySet<string | null>;
  seedMetas: ArtifactMeta[];
  ensure: (t: PlannedTarget) => Promise<ArtifactMeta | null>;
}): Promise<Map<string, PlannedTarget>> {
  const barrelTargets = new Map<string, PlannedTarget>(); // primary spec → target
  const covered = new Set<string | null>(opts.servedSpecs);
  let frontier = [...opts.seedMetas];
  while (frontier.length > 0) {
    const nextSpecs = new Set<string>();
    for (const meta of frontier) {
      for (const spec of closureSpecsOf(meta)) {
        if (!spec.startsWith("@plugins/") || covered.has(spec)) continue;
        nextSpecs.add(hostSpecOf(spec, opts.pluginsRoot));
      }
    }
    for (const spec of nextSpecs) if (covered.has(spec)) nextSpecs.delete(spec);
    // Same bounded-fan-out reasoning as `webTargets` above: `ownHashFor`'s
    // actual disk concurrency is capped by own-files.ts's shared gate, so
    // building every spec in this wave concurrently is safe.
    const built = await Promise.all(
      [...nextSpecs].sort().map(async (spec) => {
        const rel = spec.slice("@plugins/".length);
        const slash = rel.lastIndexOf("/");
        const pluginPath = rel.slice(0, slash);
        const kind = rel.slice(slash + 1);
        const pluginDir = join(opts.pluginsRoot, pluginPath);
        const barrelFile = join(pluginDir, kind, "index.ts");
        if (slash <= 0 || !existsSync(barrelFile)) {
          throw new Error(
            `artifact closure: emitted static import "${spec}" is not a folder barrel ` +
              `(expected ${barrelFile}) — cannot compose it into the import map.`,
          );
        }
        const t = await planBarrelTarget({
          pluginsRoot: opts.pluginsRoot,
          pluginPath,
          kind,
          entryFile: barrelFile,
          specifier: spec,
          identityHash: opts.identityHash,
          cache: opts.cache,
        });
        return { spec, t };
      }),
    );
    const wave: PlannedTarget[] = [];
    for (const { spec, t } of built) {
      barrelTargets.set(spec, t);
      for (const served of servedSpecsOf([t])) covered.add(served);
      wave.push(t);
    }
    const waveMetas = await Promise.all(wave.map(opts.ensure));
    frontier = waveMetas.filter((m): m is ArtifactMeta => m !== null);
  }
  return barrelTargets;
}

/**
 * One folder-barrel target of `pluginPath` (`kind` names the folder whose own
 * files, plus `shared/` and the glob roots they declare, are its address).
 */
export async function planBarrelTarget(opts: {
  pluginsRoot: string;
  pluginPath: string;
  kind: ArtifactKind;
  entryFile: string;
  specifier: string | null;
  identityHash: string;
  cache: FingerprintCache;
}): Promise<PlannedTarget> {
  const { pluginPath, kind } = opts;
  const pluginDir = join(opts.pluginsRoot, pluginPath);
  const { ownHash, globRoots } = await ownHashFor({
    cacheKey: `${pluginPath}|${kind}`,
    pluginDir,
    kind,
    cache: opts.cache,
    repoRoot: dirname(opts.pluginsRoot),
  });
  const inputsHash = computeInputsHash({
    ownHash,
    kind,
    identityHash: opts.identityHash,
  });
  const dirName = artifactDirName(pluginIdOf(pluginPath), kind, inputsHash);
  return {
    dirName,
    kind,
    pluginPath,
    specifier: opts.specifier,
    entryFile: opts.entryFile,
    inputsHash,
    globRoots,
    coEntries: coEntriesFor(kind, pluginPath, pluginDir),
    needsBuild: !hasArtifact(dirName),
  };
}

/**
 * A browser host's worker graph as artifacts: its entry (the host plugin's
 * `bin/`, kind `BROWSER_HOST_ENTRY_KIND`) and the barrel closure of what the
 * entry reaches — the generated registry's `server` barrels, every barrel they
 * import, transitively. Barrels the page already serves (`servedSpecs`) are
 * reused as they are: a `core` artifact is one artifact for page and worker.
 * Returns the entry and the targets this closure added.
 */
export async function planHostClosure(opts: {
  pluginsRoot: string;
  host: BrowserHostPlan;
  identityHash: string;
  cache: FingerprintCache;
  servedSpecs: ReadonlySet<string | null>;
  ensure: (t: PlannedTarget) => Promise<ArtifactMeta | null>;
}): Promise<{ entry: PlannedTarget; added: PlannedTarget[] }> {
  const entry = await planBarrelTarget({
    pluginsRoot: opts.pluginsRoot,
    pluginPath: opts.host.pluginPath,
    kind: BROWSER_HOST_ENTRY_KIND,
    entryFile: opts.host.entryFile,
    specifier: null,
    identityHash: opts.identityHash,
    cache: opts.cache,
  });
  const entryMeta = await opts.ensure(entry);
  if (entryMeta === null) return { entry, added: [] };
  const added = await resolveBarrelClosure({
    pluginsRoot: opts.pluginsRoot,
    identityHash: opts.identityHash,
    cache: opts.cache,
    servedSpecs: opts.servedSpecs,
    seedMetas: [entryMeta],
    ensure: opts.ensure,
  });
  return { entry, added: [...added.values()] };
}

/**
 * The specifier that actually names an artifact: a co-built folder's
 * (`@plugins/<p>/exhibits`) is its host's (`@plugins/<p>/web`); every other
 * specifier is its own. Throws when a co-built folder has no host barrel —
 * `exhibits/` without `web/` has nothing to be co-built into.
 */
export function hostSpecOf(spec: string, pluginsRoot: string): string {
  const rel = spec.slice("@plugins/".length);
  const slash = rel.lastIndexOf("/");
  if (slash <= 0) return spec;
  const pluginPath = rel.slice(0, slash);
  const folder = rel.slice(slash + 1);
  const host = cobuildHostOf(folder);
  if (host === null) return spec;
  const hostBarrel = join(pluginsRoot, pluginPath, host, "index.ts");
  if (!existsSync(hostBarrel)) {
    throw new Error(
      `artifact closure: "${spec}" is imported, but plugins/${pluginPath} has ${folder}/ ` +
        `without ${host}/ (expected ${hostBarrel}). ${folder}/ is built as a second entry ` +
        `of its plugin's ${host} artifact, so a plugin contributing one must have a ${host}/ barrel.`,
    );
  }
  if (!existsSync(join(pluginsRoot, pluginPath, folder, "index.ts"))) {
    throw new Error(
      `artifact closure: emitted import "${spec}" is not a folder barrel ` +
        `(expected ${join(pluginsRoot, pluginPath, folder, "index.ts")}).`,
    );
  }
  return `@plugins/${pluginPath}/${host}`;
}

/**
 * The vendor-set input: every bare npm specifier the emitted artifacts import
 * (static + dynamic), each paired with a resolveDir that can resolve it (the
 * lexicographically-first importing artifact's plugin dir, so plugin-local deps
 * resolve under bun's isolated installs), plus the forced always-vendored specs.
 */
export async function collectVendorRequests(opts: {
  root: string;
  pluginsRoot: string;
  /** web + core-closure + entry targets (NOT the registry). */
  targets: PlannedTarget[];
  metaOf: (dirName: string) => ArtifactMeta;
}): Promise<VendorSpecRequest[]> {
  const requests = new Map<string, string>();
  for (const t of [...opts.targets].sort((a, b) =>
    a.dirName < b.dirName ? -1 : 1,
  )) {
    const meta = opts.metaOf(t.dirName);
    const dir = t.pluginPath
      ? join(opts.pluginsRoot, t.pluginPath)
      : join(opts.root, WEB_CORE_REL);
    for (const spec of [...allStaticImports(meta), ...meta.dynamicImports]) {
      if (isBareSpecifier(spec) && !requests.has(spec)) requests.set(spec, dir);
    }
  }
  for (const spec of FORCED_VENDOR_SPECS) {
    if (!requests.has(spec)) {
      // `scheduler` is transitive (react-dom's dep): resolvable from the
      // react-dom package dir, not the repo root, under isolated installs.
      if (spec === "scheduler") {
        const { createRequire } = await import("node:module");
        const req = createRequire(join(opts.root, "package.json"));
        requests.set(spec, join(req.resolve("react-dom/package.json"), ".."));
      } else {
        requests.set(spec, opts.root);
      }
    }
  }
  return [...requests.entries()].map(([specifier, resolveDir]) => ({
    specifier,
    resolveDir,
  }));
}

/** A composed browser host, as the import map names it. */
export interface ComposedHost {
  /** `@browser-host/<pluginPath>` */
  specifier: string;
  /** The host module's store dir (`host.js`, `frames-sw.js`). */
  dirName: string;
  /** `@browser-host-worker/<pluginPath>` */
  workerSpecifier: string;
  /** The worker entry inside the dist's worker tree. */
  workerUrl: string;
}

/**
 * Every artifact a browser host's worker loads, entry first: the closure of
 * the entry's `@plugins/*` imports — static, and dynamic unless declared
 * browser-unreachable — over `targets` (page and host targets alike; a co-built
 * folder resolves to its host artifact). Every edge must land on a target:
 * the planner put each one there, so a miss is a planning bug.
 */
export function workerClosure(opts: {
  entry: PlannedTarget;
  targets: readonly PlannedTarget[];
  metaOf: (dirName: string) => ArtifactMeta;
}): PlannedTarget[] {
  const bySpec = new Map<string, PlannedTarget>();
  for (const t of opts.targets) {
    if (t.specifier !== null) bySpec.set(t.specifier, t);
    for (const e of t.coEntries) bySpec.set(e.specifier, t);
  }
  const seen = new Map<string, PlannedTarget>([
    [opts.entry.dirName, opts.entry],
  ]);
  const queue = [opts.entry];
  while (queue.length > 0) {
    const t = queue.pop()!;
    for (const spec of closureSpecsOf(opts.metaOf(t.dirName))) {
      if (!spec.startsWith("@plugins/")) continue;
      const dep = bySpec.get(spec);
      if (dep === undefined) {
        throw new Error(
          `worker closure: ${t.dirName} imports "${spec}", which no planned artifact serves`,
        );
      }
      if (seen.has(dep.dirName)) continue;
      seen.set(dep.dirName, dep);
      queue.push(dep);
    }
  }
  return [...seen.values()];
}

/**
 * The import-map entry set of a composed fleet: one entry per target specifier
 * (the entry artifact has none), the registry alias, and one entry per vendor
 * specifier. Shared by the compose step and the map-in-sync check so the
 * expected and deployed maps cannot drift by construction.
 */
export function composeMapEntries(opts: {
  /** web + core-closure + entry targets. */
  targets: PlannedTarget[];
  registryDirName: string;
  vendorMeta: VendorSetMeta;
  /** The fleet's browser hosts: the host module, and the worker entry's URL. */
  hosts: readonly ComposedHost[];
}): ImportMapEntry[] {
  const entries: ImportMapEntry[] = [];
  for (const t of opts.targets) {
    // The worker's own artifacts are reached through its link tree.
    if (WORKER_ONLY_KINDS.has(t.kind)) continue;
    if (t.specifier !== null)
      entries.push({ specifier: t.specifier, url: artifactUrl(t.dirName) });
    // One artifact, several specifiers: each co-entry is served from its own
    // emitted file inside the host artifact (`exhibits.js` beside `index.js`).
    for (const e of t.coEntries) {
      entries.push({
        specifier: e.specifier,
        url: `/artifacts/${t.dirName}/${coEntryFileName(e)}`,
      });
    }
  }
  entries.push({
    specifier: COMPOSITION_REGISTRY_SPECIFIER,
    url: artifactUrl(opts.registryDirName),
  });
  for (const host of opts.hosts) {
    entries.push({
      specifier: host.specifier,
      url: `/artifacts/${host.dirName}/${BROWSER_HOST_FILE}`,
    });
    entries.push({ specifier: host.workerSpecifier, url: host.workerUrl });
  }
  const vendorLink = vendorSetDirName(opts.vendorMeta.setHash);
  for (const [spec, file] of Object.entries(opts.vendorMeta.entries)) {
    entries.push({ specifier: spec, url: `/artifacts/${vendorLink}/${file}` });
  }
  return entries;
}
