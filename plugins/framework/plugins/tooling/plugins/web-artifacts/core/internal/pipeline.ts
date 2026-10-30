// Pipeline orchestration: detect → build (webs + entry + registry + core
// closure) → vendors → global css → compose. Stage boundaries are exposed via
// `onStage` so the caller (the build CLI) owns profiler spans. Target planning,
// the barrel closure, vendor-request assembly, and map-entry assembly live in
// `plan.ts`, shared with the `web-artifacts:map-in-sync` check.

import { existsSync, readdirSync } from "node:fs";
import os from "node:os";
import { basename, join } from "node:path";
import { createSemaphore } from "@plugins/packages/plugins/semaphore/core";
import { loadBabelContributions } from "@plugins/framework/plugins/web-core/core";
import { BUILDER_VERSION, WORKER_ONLY_KINDS } from "../constants";
import {
  findUnmappedDynamicWarnings,
  type ImportMapEntry,
} from "../import-map";
import {
  artifactUrl,
  collectVendorRequests,
  composeMapEntries,
  eagerWebTargets,
  planFleet,
  planHostClosure,
  resolveBarrelClosure,
  servedSpecsOf,
  WEB_CORE_REL,
  workerClosure,
  type ComposedHost,
  type FleetSource,
  type PlannedTarget,
} from "./plan";
import { precompressFiles } from "./precompress";
import {
  allStaticImports,
  artifactStorePath,
  ensureStoreDirs,
  loadFingerprintCache,
  hasArtifact,
  readArtifactMeta,
  saveFingerprintCache,
  touchArtifact,
  type ArtifactMeta,
} from "./store";
import {
  buildArtifact,
  buildRegistryArtifact,
  type BuilderCtx,
} from "./vite-builder";
import {
  ensureVendorSet,
  vendorSetDirName,
  vendorSetPath,
  type VendorSetMeta,
} from "./vendors";
import {
  computeGlobalCssKey,
  ensureGlobalCss,
  cssCacheDir,
  hasGlobalCssCache,
  unionCandidates,
} from "./global-css";
import {
  openBuildLease,
  pruneWebArtifactCaches,
  type BuildLease,
} from "./lease";
import { ensureBrowserHost } from "./browser-hosts";
import { composedHostsOf } from "./expected";
import {
  assertPortableArtifacts,
  ensureWorkerLinked,
  ensureWorkerTree,
  workerLinkedDirName,
  workerLinkName,
  workerTreeOf,
} from "./worker-link";
import { composeDist } from "./compose";
import { scanStagedModules } from "./staged-verify";

export interface WebArtifactsPipelineOptions {
  root: string;
  /** The build's staging dist dir (published atomically by the caller). */
  stagingDir: string;
  minify: boolean;
  buildId: string;
  /**
   * The commit this dist is composed FROM — the caller's own pre-build sample,
   * baked into index.html. `null` when git could not answer.
   */
  buildCommit: string | null;
  /** Fleet source (entry set + registry); defaults to the committed full registry. */
  source?: FleetSource;
  /**
   * A precomputed vendor set to reuse instead of resolving one from this
   * fleet's own requests. A composition dist passes MAIN's full-fleet set: its
   * targets are a strict subset of the fleet, so its vendor requests are a
   * subset by construction — extra map entries are inert (the preload BFS only
   * fetches what's imported), and compose's hard gates (every-URL-resolves +
   * the staged ground-truth scan) still verify the dist end-to-end.
   */
  vendors?: VendorSetMeta;
  /**
   * Copy every artifact (plugin artifacts AND the vendor set — they ride the
   * same `links` array) out of the shared content-addressed store into the dist
   * instead of symlinking, so the produced tree is self-contained and
   * relocatable. The release path passes this; served dists do not. Rationale
   * for materializing here rather than dereferencing at the copy site is in
   * `ComposeOptions.materialize`.
   */
  materialize?: boolean;
  log: (line: string) => void;
  /**
   * What needs the computer (boundaries' `isPlatformApi`): a browser host's
   * worker artifact importing one fails the build. Passed in, so the engine
   * depends on no checker.
   */
  isPlatformApi: (specifier: string) => boolean;
  /** Stage wrapper — the caller records profiler spans here. */
  onStage: <T>(id: string, label: string, run: () => Promise<T>) => Promise<T>;
}

export interface WebArtifactsPipelineResult {
  webArtifacts: number;
  coreArtifacts: number;
  builtArtifacts: number;
  reusedArtifacts: number;
  vendorSpecs: number;
  preloads: number;
  /**
   * Content identity of the composed graph. The caller writes it into the dist
   * (`.build-graph`) — it is what tells a tab whether the bundle it is running
   * is still the one being served.
   */
  graphHash: string;
}

export async function runWebArtifactsPipeline(
  opts: WebArtifactsPipelineOptions,
): Promise<WebArtifactsPipelineResult> {
  // Every cache entry this build reuses or publishes — artifacts (page and
  // worker), the registry, browser hosts, worker links and tree, the vendor
  // set and its package assets, the CSS cache dir — is pinned into this lease
  // BEFORE it is read or published, and the lease is held until compose has
  // linked them all into the staging dist (itself a prune root from then on),
  // so no concurrent prune can remove what this build is about to compose
  // (`lease.ts`). Released on success and failure alike; a crash releases it
  // through the kernel.
  const lease = openBuildLease();
  try {
    return await runPipeline(opts, lease);
  } finally {
    await lease.release();
  }
}

async function runPipeline(
  opts: WebArtifactsPipelineOptions,
  lease: BuildLease,
): Promise<WebArtifactsPipelineResult> {
  const { root, log } = opts;
  const pluginsRoot = join(root, "plugins");
  const webSrcDir = join(root, WEB_CORE_REL, "web");
  const worktreeName = basename(root);
  // Every stage's wall time in the transcript too: a caller without profiler
  // spans (the hermetic build) still shows where a cold build spent it.
  const stage = async <T>(
    id: string,
    label: string,
    run: () => Promise<T>,
  ): Promise<T> => {
    const t0 = performance.now();
    const out = await opts.onStage(id, label, run);
    log(`stage ${id}: ${((performance.now() - t0) / 1000).toFixed(2)}s`);
    return out;
  };

  // ── Stage 1: detect ─────────────────────────────────────────────────
  const cache = loadFingerprintCache(worktreeName);
  const plan = await stage(
    "artifacts:detect",
    "detect changed artifacts",
    async () => {
      ensureStoreDirs();
      await pruneWebArtifactCaches();

      const fleet = await planFleet({
        root,
        minify: opts.minify,
        cache,
        source: opts.source,
      });
      saveFingerprintCache(worktreeName, cache);
      log(
        `detect: ${fleet.webTargets.length} web artifacts (${fleet.staleWeb} stale), entry ${fleet.entryTarget.needsBuild ? "stale" : "cached"}, registry ${fleet.registryTarget.needsBuild ? "stale" : "cached"}`,
      );
      return fleet;
    },
  );

  // ── Stage 2: build (webs + entry + registry, then the core closure) ─
  // One builder for every artifact, page and worker alike: the host stage
  // below builds its closure through the same `ensure`.
  const ctx: BuilderCtx = {
    repoRoot: root,
    pluginsRoot,
    babelPlugins: await loadBabelContributions({
      pluginsRoot,
      repoRoot: root,
    }),
    minify: opts.minify,
  };
  const gate = createSemaphore(
    Math.min(8, Math.max(2, Math.floor(os.cpus().length / 2))),
  );
  const metas = new Map<string, ArtifactMeta>(); // dirName → meta
  const counts = { built: 0, reused: 0 };
  // Pin first, then look: planning read the store before this build held
  // anything, so a prune since may have taken a planned reuse — which then
  // simply builds.
  const ensure = async (t: PlannedTarget): Promise<ArtifactMeta> => {
    await lease.pin([artifactStorePath(t.dirName)]);
    if (t.needsBuild || !hasArtifact(t.dirName)) {
      const meta = await gate.run(() => buildArtifact(t, ctx));
      metas.set(t.dirName, meta);
      counts.built++;
      return meta;
    }
    touchArtifact(t.dirName);
    const meta = readArtifactMeta(t.dirName);
    metas.set(t.dirName, meta);
    counts.reused++;
    return meta;
  };

  const buildOut = await stage(
    "artifacts:build",
    `build artifacts (${plan.staleWeb + (plan.entryTarget.needsBuild ? 1 : 0)} stale)`,
    async () => {
      const registryPromise = (async () => {
        await lease.pin([artifactStorePath(plan.registryTarget.dirName)]);
        if (
          plan.registryTarget.needsBuild ||
          !hasArtifact(plan.registryTarget.dirName)
        ) {
          const meta = await buildRegistryArtifact({
            dirName: plan.registryTarget.dirName,
            inputsHash: plan.registryTarget.inputsHash,
            registryFile: plan.registryTarget.registryFile,
            minify: opts.minify,
          });
          metas.set(plan.registryTarget.dirName, meta);
          counts.built++;
        } else {
          touchArtifact(plan.registryTarget.dirName);
          metas.set(
            plan.registryTarget.dirName,
            readArtifactMeta(plan.registryTarget.dirName),
          );
          counts.reused++;
        }
      })();

      await Promise.all([
        ...plan.webTargets.map(ensure),
        ensure(plan.entryTarget),
        registryPromise,
      ]);

      const barrelTargets = await resolveBarrelClosure({
        pluginsRoot,
        identityHash: plan.identity.identityHash,
        cache,
        servedSpecs: servedSpecsOf(plan.webTargets),
        seedMetas: [...metas.values()],
        ensure,
      });
      saveFingerprintCache(worktreeName, cache);

      log(
        `build: ${counts.built} built, ${counts.reused} reused (${barrelTargets.size} barrel artifacts)`,
      );
      return { metas, coreTargets: [...barrelTargets.values()] };
    },
  );

  // ── Stage 2b: browser hosts ─────────────────────────────────────────
  // Each host's worker graph is per-plugin artifacts: its `bin/` entry and the
  // barrel closure it reaches (the `server` barrels, any `core` the page does
  // not already serve), built by the same `ensure`; then the host's page-side
  // module (`host.js` + the frame-serving Service Worker).
  const pageTargets: PlannedTarget[] = [
    ...plan.webTargets,
    ...buildOut.coreTargets,
    plan.entryTarget,
  ];
  const hosts = await stage(
    "artifacts:browser-hosts",
    `browser hosts (${plan.hosts.length})`,
    async () => {
      const before = { ...counts };
      const out: Array<{
        plan: (typeof plan.hosts)[number];
        dirName: string;
        entry: PlannedTarget;
        added: PlannedTarget[];
      }> = [];
      const served = servedSpecsOf(pageTargets);
      for (const host of plan.hosts) {
        const { entry, added } = await planHostClosure({
          pluginsRoot,
          host,
          identityHash: plan.identity.identityHash,
          cache,
          servedSpecs: served,
          ensure,
        });
        for (const s of servedSpecsOf(added)) served.add(s);
        assertPortableArtifacts(
          [entry, ...added].map((t) => ({
            dirName: t.dirName,
            meta: metas.get(t.dirName)!,
          })),
          opts.isPlatformApi,
        );
        const dirName = await ensureBrowserHost({
          root,
          plan: host,
          identityHash: plan.identity.identityHash,
          minify: opts.minify,
          log,
          pin: (paths) => lease.pin(paths),
        });
        out.push({ plan: host, dirName, entry, added });
      }
      saveFingerprintCache(worktreeName, cache);
      log(
        `browser hosts: ${out.length} host(s), ${out.reduce((n, h) => n + h.added.length + 1, 0)} worker artifacts planned (${counts.built - before.built} built, ${counts.reused - before.reused} reused)`,
      );
      return out;
    },
  );

  // ── Stage 3: vendors ────────────────────────────────────────────────
  // Every artifact's npm imports, page and worker: one vendor set serves both.
  const allTargets: PlannedTarget[] = [
    ...pageTargets,
    ...hosts.flatMap((h) => [h.entry, ...h.added]),
  ];

  const vendors = await stage(
    "artifacts:vendors",
    "vendor pre-bundles",
    async () => {
      if (opts.vendors !== undefined) {
        const dest = vendorSetPath(opts.vendors.setHash);
        await lease.pin([dest]);
        if (!existsSync(join(dest, "meta.json"))) {
          throw new Error(
            `vendors: the given set ${opts.vendors.setHash.slice(0, 12)} is not in the store (${dest})`,
          );
        }
        log(
          `vendors: reusing set ${opts.vendors.setHash.slice(0, 12)} ` +
            `(${Object.keys(opts.vendors.entries).length} specifiers)`,
        );
        return opts.vendors;
      }
      const requests = await collectVendorRequests({
        root,
        pluginsRoot,
        targets: allTargets,
        metaOf: (dirName) => buildOut.metas.get(dirName)!,
      });
      const { meta, stats } = await ensureVendorSet({
        requests,
        minify: opts.minify,
        builderVersion: BUILDER_VERSION,
        builderSource: plan.identity.sourceDigest,
        root,
        pin: (paths) => lease.pin(paths),
      });
      log(
        `vendors: ${requests.length} specifiers, ${stats.cached} cached / ${stats.resolved} resolved ` +
          `in ${stats.elapsedMs}ms (set ${meta.setHash.slice(0, 12)})`,
      );
      return meta;
    },
  );

  // ── Stage 4: global css ─────────────────────────────────────────────
  // The union of the shipped artifacts' candidates (recorded at build), then
  // one compile from the list when the union's key is not cached.
  const cssInput = await stage(
    "artifacts:css-key",
    "global css candidates",
    async () => {
      const shipped = allTargets
        .filter((t) => !WORKER_ONLY_KINDS.has(t.kind))
        .map((t) => t.dirName);
      const candidates = unionCandidates(
        shipped.map((dirName) => buildOut.metas.get(dirName)!),
        (i) => shipped[i]!,
      );
      const key = computeGlobalCssKey({
        pluginsRoot,
        minify: opts.minify,
        candidates,
      });
      return { key, candidates };
    },
  );
  const cssKey = cssInput.key;
  // Pinned until ensureGlobalCss has copied the stylesheet into staging.
  await lease.pin([cssCacheDir(cssKey)]);
  const cssCached = hasGlobalCssCache(cssKey);
  const css = await stage(
    "artifacts:css",
    cssCached ? "global css (cached)" : "global css compile",
    () =>
      ensureGlobalCss({
        repoRoot: root,
        pluginsRoot,
        stagingDir: opts.stagingDir,
        minify: opts.minify,
        key: cssKey,
        candidates: cssInput.candidates,
      }),
  );
  log(
    `css: ${css.cached ? "cache hit" : "compiled"} from ${cssInput.candidates.length} candidates (key ${cssKey.slice(0, 12)})`,
  );

  // ── Stage 4b: worker trees ──────────────────────────────────────────
  // Each host's closure, linked for the worker (`worker-link.ts`), under ONE
  // tree entry per build: the page maps each host's worker entry into it.
  const workerTree = await stage(
    "artifacts:worker-link",
    "worker link tree",
    async () => {
      if (hosts.length === 0) return null;
      const linked = new Map<
        string,
        { linkName: string; linkedDirName: string }
      >();
      for (const host of hosts) {
        const closure = workerClosure({
          entry: host.entry,
          targets: allTargets,
          metaOf: (dirName) => buildOut.metas.get(dirName)!,
        });
        for (const t of closure) {
          if (linked.has(t.dirName)) continue;
          linked.set(t.dirName, {
            linkName: workerLinkName(t.pluginPath!, t.kind),
            linkedDirName: workerLinkedDirName(t.dirName),
          });
        }
      }
      const gateLink = createSemaphore(8);
      await Promise.all(
        [...linked.keys()].map((dirName) =>
          gateLink.run(async () => {
            await lease.pin([artifactStorePath(workerLinkedDirName(dirName))]);
            await ensureWorkerLinked({
              dirName,
              vendorEntries: vendors.entries,
            });
          }),
        ),
      );
      const tree = workerTreeOf({
        linked: [...linked.values()],
        vendorSetDir: vendorSetPath(vendors.setHash),
      });
      await lease.pin([artifactStorePath(tree.dirName)]);
      await ensureWorkerTree(tree);
      log(`worker tree: ${linked.size} artifacts linked (${tree.dirName})`);
      return {
        tree,
        linked: [...linked.values()].map((l) => l.linkedDirName),
      };
    },
  );
  // The same derivation the map-in-sync check runs (`expected.ts`).
  const composedHosts: ComposedHost[] = composedHostsOf({
    hosts,
    targets: allTargets,
    metas: buildOut.metas,
    vendorSetHash: vendors.setHash,
  });
  if (
    workerTree !== null &&
    composedHosts.some(
      (h) => !h.workerUrl.startsWith(`/artifacts/${workerTree.tree.dirName}/`),
    )
  ) {
    throw new Error(
      `worker tree: the linked tree ${workerTree.tree.dirName} is not the one the import map names`,
    );
  }

  // ── Stage 5: compose ────────────────────────────────────────────────
  const composed = await stage(
    "artifacts:compose",
    "compose dist",
    async () => {
      const links: Array<{ linkName: string; storePath: string }> = [];
      const staticImportsByUrl: Record<string, string[]> = {};
      const emitted: Array<{ importer: string; specifiers: string[] }> = [];

      // Coverage is STRICT for static imports (a miss breaks module evaluation)
      // and for the registry's dynamic imports (its loaders are the app). Other
      // artifacts' dynamic imports are mapped by construction too — the barrel
      // closure follows them — EXCEPT the kinds declared browser-unreachable
      // (BROWSER_UNREACHABLE_DYNAMIC_KINDS), which are silent by declaration.
      // Anything else unmapped here is a pipeline bug and warns loudly.
      const dynamicOnly: Array<{ importer: string; specifiers: string[] }> = [];
      const registerArtifact = (
        dirName: string,
        strictDynamic: boolean,
      ): void => {
        links.push({
          linkName: dirName,
          storePath: artifactStorePath(dirName),
        });
        const meta = buildOut.metas.get(dirName)!;
        // Per emitted file (index.js + code-split .mjs chunks): the preload BFS
        // must walk real static edges, so a lazy chunk's deps stay unpreloaded.
        for (const [file, imports] of Object.entries(
          meta.staticImportsByFile,
        )) {
          staticImportsByUrl[`/artifacts/${dirName}/${file}`] = imports;
        }
        const statics = allStaticImports(meta);
        emitted.push({
          importer: dirName,
          specifiers: strictDynamic
            ? [...statics, ...meta.dynamicImports]
            : statics,
        });
        if (!strictDynamic && meta.dynamicImports.length > 0) {
          dynamicOnly.push({
            importer: dirName,
            specifiers: meta.dynamicImports,
          });
        }
      };

      // Every target the page's map names: the page fleet, and the `core`
      // barrels only a browser host's worker reaches (mapped like any core).
      for (const t of allTargets) {
        if (!WORKER_ONLY_KINDS.has(t.kind)) registerArtifact(t.dirName, false);
      }
      registerArtifact(plan.registryTarget.dirName, true);

      // Map entries: one per target specifier + the registry alias + one per
      // vendor specifier — assembled by the same helper the map-in-sync check
      // recomputes with, so the two cannot drift.
      const mapEntries: ImportMapEntry[] = composeMapEntries({
        targets: allTargets,
        registryDirName: plan.registryTarget.dirName,
        vendorMeta: vendors,
        hosts: composedHosts,
      });
      for (const host of hosts) {
        links.push({
          linkName: host.dirName,
          storePath: artifactStorePath(host.dirName),
        });
      }
      if (workerTree !== null) {
        links.push({
          linkName: workerTree.tree.dirName,
          storePath: artifactStorePath(workerTree.tree.dirName),
        });
        // Each linked copy at the top level too: the served-root form every
        // pruner reads (a tree's own links are not followed by older ones).
        for (const linked of workerTree.linked) {
          links.push({
            linkName: linked,
            storePath: artifactStorePath(linked),
          });
        }
      }

      // Vendor set: one symlink; per-file imports feed the preload closure.
      const vendorLink = vendorSetDirName(vendors.setHash);
      links.push({
        linkName: vendorLink,
        storePath: vendorSetPath(vendors.setHash),
      });
      for (const [file, imports] of Object.entries(vendors.imports)) {
        staticImportsByUrl[`/artifacts/${vendorLink}/${file}`] = imports;
      }

      const entryUrl = artifactUrl(plan.entryTarget.dirName);
      const eagerSeeds = eagerWebTargets(
        plan.webTargets,
        plan.deferredPaths,
      ).map((t) => artifactUrl(t.dirName));
      const preloadSeeds = [
        entryUrl,
        artifactUrl(plan.registryTarget.dirName),
        ...eagerSeeds,
      ];

      const { importMap, preloads, graphHash } = composeDist({
        stagingDir: opts.stagingDir,
        webSrcDir,
        buildId: opts.buildId,
        buildCommit: opts.buildCommit,
        minify: opts.minify,
        cssHref: css.href,
        links,
        materialize: opts.materialize,
        mapEntries,
        staticImportsByUrl,
        emitted,
        entryUrl,
        preloadSeeds,
      });
      // The shell's own files (index.html, public/): every other served file
      // came out of a cache entry published with its sidecars.
      await precompressFiles(
        readdirSync(opts.stagingDir, { withFileTypes: true })
          .filter((d) => d.isFile())
          .map((d) => join(opts.stagingDir, d.name)),
      );
      const unmappedDynamic = findUnmappedDynamicWarnings(
        dynamicOnly,
        importMap,
      );
      for (const u of unmappedDynamic) {
        log(
          `warning: dynamic import "${u.specifier}" (from ${u.importer}) has no import-map entry — ` +
            `it will fail if ever invoked in the browser`,
        );
      }

      // Ground truth: re-scan the STAGED module files themselves (through the
      // store symlinks) — independent of the builders' meta.json, so a scanner
      // blind spot cannot blind this gate too. Verifies both specifier
      // resolution and the linkage of every bound name: an importer is reused
      // from the store unrebuilt when its target changes, so this is the only
      // place the composed fleet's bytes are ever read against each other.
      const groundTruth = await scanStagedModules({
        stagingDir: opts.stagingDir,
        imports: importMap.imports,
      });
      for (const w of groundTruth.warnings) {
        log(
          `warning: staged dynamic import "${w.specifier}" (in ${w.file}) has no import-map entry — ` +
            `it will fail if ever invoked in the browser`,
        );
      }
      for (const file of groundTruth.opaqueTargets) {
        log(
          `warning: staged module ${file} emits \`export *\` — its export set is incomplete, ` +
            `so imports of its names are NOT link-verified`,
        );
      }
      if (groundTruth.failures.length > 0) {
        const lines = groundTruth.failures.map(
          (f) => `  ${f.specifier}  (in ${f.file})`,
        );
        throw new Error(
          `compose: ${groundTruth.failures.length} staged import(s) do not resolve ` +
            `(ground-truth scan of the staged dist):\n${lines.join("\n")}`,
        );
      }
      if (groundTruth.linkFailures.length > 0) {
        const lines = groundTruth.linkFailures.map(
          (f) =>
            `  "${f.specifier}" does not export "${f.name}"  (imported by ${f.file})`,
        );
        throw new Error(
          `compose: ${groundTruth.linkFailures.length} staged import(s) do not link ` +
            `(ground-truth scan of the staged dist):\n${lines.join("\n")}`,
        );
      }

      log(
        `compose: ${links.length} links, ${mapEntries.length} map entries, ${preloads.length} preloads`,
      );
      return { preloads, graphHash };
    },
  );

  return {
    webArtifacts: plan.webTargets.length,
    coreArtifacts: buildOut.coreTargets.length,
    builtArtifacts: counts.built,
    reusedArtifacts: counts.reused,
    vendorSpecs: Object.keys(vendors.entries).length,
    preloads: composed.preloads.length,
    graphHash: composed.graphHash,
  };
}
