// Pipeline orchestration: detect → build (webs + entry + registry + core
// closure) → vendors → global css → compose. Stage boundaries are exposed via
// `onStage` so the caller (the build CLI) owns profiler spans. Target planning,
// the barrel closure, vendor-request assembly, and map-entry assembly live in
// `plan.ts`, shared with the `web-artifacts:map-in-sync` check.

import os from "node:os";
import { basename, join } from "node:path";
import { createSemaphore } from "@plugins/packages/plugins/semaphore/core";
import { loadBabelContributions } from "@plugins/framework/plugins/web-core/core";
import { BUILDER_VERSION } from "../constants";
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
  resolveBarrelClosure,
  servedSpecsOf,
  WEB_CORE_REL,
  type FleetSource,
  type PlannedTarget,
} from "./plan";
import {
  allStaticImports,
  artifactStorePath,
  ensureStoreDirs,
  loadFingerprintCache,
  pruneStore,
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
  pruneVendorSets,
  vendorSetDirName,
  vendorSetPath,
  type VendorSetMeta,
} from "./vendors";
import {
  computeGlobalCssKey,
  ensureGlobalCss,
  hasGlobalCssCache,
  pruneGlobalCssCache,
} from "./global-css";
import { ensureBrowserHost } from "./browser-hosts";
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
  const { root, log } = opts;
  const pluginsRoot = join(root, "plugins");
  const webSrcDir = join(root, WEB_CORE_REL, "web");
  const worktreeName = basename(root);

  // ── Stage 1: detect ─────────────────────────────────────────────────
  const cache = loadFingerprintCache(worktreeName);
  const plan = await opts.onStage(
    "artifacts:detect",
    "detect changed artifacts",
    async () => {
      ensureStoreDirs();
      pruneStore();
      pruneVendorSets();
      pruneGlobalCssCache();

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
  const buildOut = await opts.onStage(
    "artifacts:build",
    `build artifacts (${plan.staleWeb + (plan.entryTarget.needsBuild ? 1 : 0)} stale)`,
    async () => {
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
      let built = 0;
      let reused = 0;

      const ensure = async (t: PlannedTarget): Promise<ArtifactMeta> => {
        if (t.needsBuild) {
          const meta = await gate.run(() => buildArtifact(t, ctx));
          metas.set(t.dirName, meta);
          built++;
          return meta;
        }
        touchArtifact(t.dirName);
        const meta = readArtifactMeta(t.dirName);
        metas.set(t.dirName, meta);
        reused++;
        return meta;
      };

      const registryPromise = (async () => {
        if (plan.registryTarget.needsBuild) {
          const meta = await buildRegistryArtifact({
            dirName: plan.registryTarget.dirName,
            inputsHash: plan.registryTarget.inputsHash,
            registryFile: plan.registryTarget.registryFile,
            configLayerFile: plan.registryTarget.configLayerFile,
            minify: opts.minify,
          });
          metas.set(plan.registryTarget.dirName, meta);
          built++;
        } else {
          touchArtifact(plan.registryTarget.dirName);
          metas.set(
            plan.registryTarget.dirName,
            readArtifactMeta(plan.registryTarget.dirName),
          );
          reused++;
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
        `build: ${built} built, ${reused} reused (${barrelTargets.size} barrel artifacts)`,
      );
      return { metas, coreTargets: [...barrelTargets.values()], built, reused };
    },
  );

  // ── Stage 2b: browser hosts (whole-graph worker bundles) ────────────
  const hosts = await opts.onStage(
    "artifacts:browser-hosts",
    `browser hosts (${plan.hosts.filter((h) => h.needsBuild).length} stale)`,
    async () => {
      const out: Array<{ specifier: string; dirName: string }> = [];
      // One at a time: each is a whole-graph vite build.
      for (const host of plan.hosts) {
        const dirName = await ensureBrowserHost({
          root,
          plan: host,
          identityHash: plan.identity.identityHash,
          minify: opts.minify,
          log,
        });
        out.push({ specifier: host.specifier, dirName });
      }
      return out;
    },
  );

  // ── Stage 3: vendors ────────────────────────────────────────────────
  const allTargets: PlannedTarget[] = [
    ...plan.webTargets,
    ...buildOut.coreTargets,
    plan.entryTarget,
  ];

  const vendors = await opts.onStage(
    "artifacts:vendors",
    "vendor pre-bundles",
    async () => {
      if (opts.vendors !== undefined) {
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
      });
      log(
        `vendors: ${requests.length} specifiers, ${stats.cached} cached / ${stats.resolved} resolved ` +
          `in ${stats.elapsedMs}ms (set ${meta.setHash.slice(0, 12)})`,
      );
      return meta;
    },
  );

  // ── Stage 4: global css ─────────────────────────────────────────────
  const cssKey = await opts.onStage(
    "artifacts:css-key",
    "global css input fingerprint",
    async () => {
      const key = await computeGlobalCssKey({
        repoRoot: root,
        pluginsRoot,
        minify: opts.minify,
        cache,
      });
      saveFingerprintCache(worktreeName, cache);
      return key;
    },
  );
  const cssCached = hasGlobalCssCache(cssKey);
  const css = await opts.onStage(
    "artifacts:css",
    cssCached ? "global css (cached)" : "global tailwind pass",
    () =>
      ensureGlobalCss({
        repoRoot: root,
        pluginsRoot,
        stagingDir: opts.stagingDir,
        minify: opts.minify,
        key: cssKey,
      }),
  );
  log(
    `css: ${css.cached ? "cache hit" : "tailwind pass"} (key ${cssKey.slice(0, 12)})`,
  );

  // ── Stage 5: compose ────────────────────────────────────────────────
  const composed = await opts.onStage(
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

      for (const t of allTargets) registerArtifact(t.dirName, false);
      registerArtifact(plan.registryTarget.dirName, true);

      // Map entries: one per target specifier + the registry alias + one per
      // vendor specifier — assembled by the same helper the map-in-sync check
      // recomputes with, so the two cannot drift.
      const mapEntries: ImportMapEntry[] = composeMapEntries({
        targets: allTargets,
        registryDirName: plan.registryTarget.dirName,
        vendorMeta: vendors,
        hosts,
      });
      for (const host of hosts) {
        links.push({
          linkName: host.dirName,
          storePath: artifactStorePath(host.dirName),
        });
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
    builtArtifacts: buildOut.built,
    reusedArtifacts: buildOut.reused,
    vendorSpecs: Object.keys(vendors.entries).length,
    preloads: composed.preloads.length,
    graphHash: composed.graphHash,
  };
}
