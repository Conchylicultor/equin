// Pipeline orchestration: detect → build (webs + entry + registry + core
// closure) → vendors → global css → compose. Stage boundaries are exposed via
// `onStage` so the caller (the build CLI) owns profiler spans. Target planning,
// the barrel closure, vendor-request assembly, and map-entry assembly live in
// `plan.ts`, shared with the `web-artifacts:map-in-sync` check.

import {
  existsSync,
  readdirSync,
} from "@plugins/packages/plugins/timed-fs/core";
import {
  joinAppPath,
  type AppPath,
} from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import os from "node:os";
import { createSemaphore } from "@plugins/packages/plugins/semaphore/core";
import {
  BUILDER_VERSION,
  isBrowserUnreachableDynamic,
  WORKER_ONLY_KINDS,
} from "../constants";
import type { ImportMapEntry } from "../import-map";
import {
  collectVendorRequests,
  composeMapEntries,
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
  edgesOf,
  artifactStorePath,
  ensureStoreDirs,
  loadGlobPatternMemo,
  hasArtifact,
  readArtifactMeta,
  touchArtifact,
  type ArtifactMeta,
} from "./store";
import { buildRegistryArtifact } from "./vite-builder";
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
import { openBuildLease, type BuildLease } from "./lease";
import { ensureBrowserHost } from "./browser-hosts";
import {
  ensureHostSnapshot,
  ensurePgliteCluster,
  hostSnapshotLinks,
  pgliteClusterDirName,
} from "./host-snapshots";
import type { OwnSources } from "./own-files";
import {
  installedRepoView,
  loadRepoSnapshot,
} from "@plugins/framework/plugins/tooling/core";
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
import { ensureLink, linkInputsOf } from "./link";
import {
  crawlSnapshotDirName,
  ensureCrawlSnapshot,
  stageCrawlSnapshot,
} from "./crawl-snapshot";
import {
  createArtifactBuildHandler,
  type ArtifactBuilder,
} from "./artifact-builder";
import { scanStagedModules } from "./staged-verify";

export interface WebArtifactsPipelineOptions {
  root: AppPath;
  /** The build's staging dist dir (published atomically by the caller). */
  stagingDir: AppPath;
  minify: boolean;
  buildId: string;
  /**
   * The commit this dist is composed FROM — the caller's own pre-build sample,
   * baked into index.html. `null` when git could not answer.
   */
  buildCommit: string | null;
  /**
   * Central's code build as the source tree holds it, baked into index.html
   * (`composeDist`'s `centralBuild`). Started as the pipeline starts — the
   * digest is a closure walk (seconds), run beside the artifact builds — and
   * awaited at compose, where a failure fails the build. Resolves `null` for a
   * dist no central serves (a release).
   */
  centralBuild: () => Promise<string | null>;
  /** Fleet source (entry set + registry); defaults to the committed full registry. */
  source?: FleetSource;
  /**
   * Take the crawl snapshot of this composition (its pages rendered once for
   * robots, `crawl-snapshot.ts`) and stage it into the dist. Set by the build
   * CLI only for a composition declared `crawlable: true`, so every other
   * build pays nothing.
   */
  crawl?: { composition: string };
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
  /**
   * A served dist's address dir (its namespace's persistent `<name> → store`
   * links): compose links this graph into it and stages `artifacts` as a
   * link to it — see `ComposeOptions.addressDir`. Unset for a release.
   */
  addressDir?: AppPath;
  log: (line: string) => void;
  /**
   * What needs the computer (boundaries' `isPlatformApi`): a browser host's
   * worker artifact importing one fails the build. Passed in, so the engine
   * depends on no checker.
   */
  isPlatformApi: (specifier: string) => boolean;
  /**
   * Where stale artifacts compile. Omitted: in this process, a few at a time —
   * which shares its one JS thread. The build CLI passes a pooled builder
   * (`cli/`'s `createPooledArtifactBuilder`).
   */
  builder?: ArtifactBuilder;
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
  /**
   * Every name the dist links under `artifacts/` (page and worker artifacts,
   * the registry, browser hosts, worker tree, vendor set, crawl snapshot) —
   * what a tab of this graph can fetch, and what keeps the worker-only
   * artifacts rooted. A served build records it as the graph's record, which
   * bounds the namespace's address dir (`cli/`'s address-dir retention).
   */
  linkNames: string[];
}

/**
 * The default builder: this process, a few builds at a time. Their vite and
 * Rolldown work overlaps; their Babel pass does not (one JS thread).
 */
function inProcessBuilder(repoRoot: AppPath, minify: boolean): ArtifactBuilder {
  const handle = createArtifactBuildHandler();
  const gate = createSemaphore(
    Math.min(8, Math.max(2, Math.floor(os.cpus().length / 2))),
  );
  return {
    build: (target) => gate.run(() => handle({ repoRoot, minify, target })),
  };
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
  // Settled, not raw: a pipeline that fails before compose never awaits it,
  // and its rejection must not then surface as an unhandled one. Compose
  // rethrows it.
  const centralBuild = opts.centralBuild().then(
    (build) => ({ ok: true as const, build }),
    (error: unknown) => ({ ok: false as const, error }),
  );
  try {
    return await runPipeline(opts, lease, centralBuild);
  } finally {
    await lease.release();
  }
}

async function runPipeline(
  opts: WebArtifactsPipelineOptions,
  lease: BuildLease,
  centralBuild: Promise<
    { ok: true; build: string | null } | { ok: false; error: unknown }
  >,
): Promise<WebArtifactsPipelineResult> {
  const { root, log } = opts;
  const pluginsRoot = joinAppPath(root, "plugins");
  const webSrcDir = joinAppPath(root, WEB_CORE_REL, "web");
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
  // Every address is read off ONE repo snapshot, taken here — after codegen
  // and the formatter wrote, so a generated file is addressed by what it now
  // holds — and its content ids: no walk, no stat, no read of an unchanged
  // file (`own-files.ts`).
  const sources: OwnSources = {
    snapshot: await stage("artifacts:snapshot", "repo snapshot", async () => {
      const snapshot = await loadRepoSnapshot(root);
      // Inside a build, this fresh snapshot is also the check of the build's
      // view (`openRepoView`): every answer codegen read off the view must
      // still hold, or a record was keyed by bytes a file no longer has.
      await installedRepoView(root)?.assertAgrees(snapshot);
      return snapshot;
    }),
    globs: loadGlobPatternMemo(),
  };
  const plan = await stage(
    "artifacts:detect",
    "detect changed artifacts",
    async () => {
      // No prune here: it reads every dist of every checkout (O(the host's
      // caches), not O(this change)), so it runs as the scheduled
      // `web-artifacts.prune` job — the build's lease keeps what it composes.
      ensureStoreDirs();
      const fleet = await planFleet({
        root,
        minify: opts.minify,
        sources,
        source: opts.source,
        step: (id, run) =>
          stage(`artifacts:detect:${id}`, `detect: ${id}`, run),
      });
      sources.globs.save();
      // Planning is pure hashing; which addresses the store lacks is asked
      // here, for the log. `ensure` asks again after pinning — the answer can
      // change either way in between (a prune, a concurrent build's publish).
      const staleWeb = fleet.webTargets.filter(
        (t) => !hasArtifact(t.dirName),
      ).length;
      const entryStale = !hasArtifact(fleet.entryTarget.dirName);
      log(
        `detect: ${fleet.webTargets.length} web artifacts (${staleWeb} stale), entry ${entryStale ? "stale" : "cached"}, registry ${hasArtifact(fleet.registryTarget.dirName) ? "cached" : "stale"}`,
      );
      return { ...fleet, staleWeb, entryStale };
    },
  );

  // ── Stage 2: build (webs + entry + registry, then the core closure) ─
  // One builder for every artifact, page and worker alike: the host stage
  // below builds its closure through the same `ensure`.
  const builder = opts.builder ?? inProcessBuilder(root, opts.minify);
  const metas = new Map<string, ArtifactMeta>(); // dirName → meta
  const counts = { built: 0, reused: 0 };
  // Pin first, then look: a prune between detect and here may have taken a
  // reuse — which then simply builds.
  const ensure = async (t: PlannedTarget): Promise<ArtifactMeta> => {
    await lease.pin([artifactStorePath(t.dirName)]);
    if (!hasArtifact(t.dirName)) {
      const meta = await builder.build(t);
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
    `build artifacts (${plan.staleWeb + (plan.entryStale ? 1 : 0)} stale)`,
    async () => {
      const registryPromise = (async () => {
        await lease.pin([artifactStorePath(plan.registryTarget.dirName)]);
        if (!hasArtifact(plan.registryTarget.dirName)) {
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
        sources,
        servedSpecs: servedSpecsOf(plan.webTargets),
        seedMetas: [...metas.values()],
        ensure,
      });
      sources.globs.save();

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
          sources,
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
      sources.globs.save();
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
        if (!existsSync(joinAppPath(dest, "meta.json"))) {
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

  // ── Stage 4a: host snapshots ────────────────────────────────────────
  // Each host that declares a starting snapshot (`bin/browser-host.snapshot.ts`)
  // gets it taken once per address (`host-snapshots.ts`: keyed on every
  // module the take can run and the data it reads) and linked into the worker tree below.
  const snapshotLinks = await stage(
    "artifacts:host-snapshots",
    "host snapshots",
    async () => {
      const links = await hostSnapshotLinks({
        repo: sources.snapshot,
        hosts: hosts.map((h) => ({
          pluginPath: h.plan.pluginPath,
          entry: h.entry,
        })),
        targets: allTargets,
        metaOf: (dirName) => buildOut.metas.get(dirName)!,
      });
      const clusterDirName = await pgliteClusterDirName(sources.snapshot);
      for (const link of links) {
        await ensureHostSnapshot({
          root,
          pluginPath: link.pluginPath,
          dirName: link.linkedDirName,
          clusterDirName,
          log,
          pin: (paths) => lease.pin(paths),
        });
      }
      return links;
    },
  );

  // ── Stage 4a': crawl snapshot ──────────────────────────────────────
  // A crawlable composition's pages, rendered once per address
  // (`crawl-snapshot.ts`: keyed on the take's code, the composition's web
  // code and the data they read) and staged into the dist by compose below.
  const crawl = await stage(
    "artifacts:crawl-snapshot",
    "crawl snapshot",
    async () => {
      if (opts.crawl === undefined) return null;
      const { composition } = opts.crawl;
      const clusterDirName = await pgliteClusterDirName(sources.snapshot);
      const { dirName, take } = await crawlSnapshotDirName({
        sources,
        composition,
        webPlugins: plan.webTargets.map((t) => t.pluginPath!),
        clusterDirName,
      });
      const took = await ensureCrawlSnapshot({
        root,
        composition,
        dirName,
        take,
        cluster: () =>
          ensurePgliteCluster({
            root,
            dirName: clusterDirName,
            log,
            pin: (paths) => lease.pin(paths),
          }),
        log,
        pin: (paths) => lease.pin(paths),
      });
      log(
        `crawl snapshot ${composition}: ${took ? "taken" : "cache hit"} (${dirName})`,
      );
      return { dirName };
    },
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
        linked: [...linked.values(), ...snapshotLinks],
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
    snapshotLinks,
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

  // ── Stage 4c: link ──────────────────────────────────────────────────
  // The page's modules, each cross-plugin import resolved to the module
  // defining the name, regrouped into route chunks (`link.ts`).
  const linked = await stage(
    "artifacts:link",
    "link route chunks",
    async () => {
      const out = await ensureLink({
        ...linkInputsOf({
          identityHash: plan.identity.identityHash,
          minify: opts.minify,
          pageTargets: [...plan.webTargets, ...buildOut.coreTargets],
          entryDirName: plan.entryTarget.dirName,
          registryDirName: plan.registryTarget.dirName,
          vendorSet: vendors,
          deferredPaths: plan.deferredPaths,
        }),
        pin: (paths) => lease.pin(paths),
        log,
      });
      log(
        `link: ${out.cached ? "reused" : "linked"} ${out.record.chunks.length} chunks ` +
          `(${out.record.stats.bootChunks} boot, ${out.record.stats.modules} modules)`,
      );
      return out;
    },
  );

  // ── Stage 5: compose ────────────────────────────────────────────────
  const composed = await stage(
    "artifacts:compose",
    "compose dist",
    async () => {
      const links: Array<{ linkName: string; storePath: AppPath }> = [];
      const staticImportsByUrl: Record<string, string[]> = {};
      const emitted: Array<{ importer: string; specifiers: string[] }> = [];

      // The page loads the route chunks (`link.ts`): every chunk's static and
      // dynamic imports must resolve — its relative ones are chunk URLs, its
      // bare ones vendors and hosts, through the map.
      for (const [dirName, meta] of linked.chunkMetas) {
        links.push({
          linkName: dirName,
          storePath: artifactStorePath(dirName),
        });
        staticImportsByUrl[`/artifacts/${dirName}/index.js`] =
          meta.staticImportsByFile["index.js"] ?? [];
        emitted.push({
          importer: dirName,
          specifiers: [
            ...allStaticImports(meta),
            // A leaf folder's loader is never invoked in the browser and
            // never mapped (`BROWSER_UNREACHABLE_DYNAMIC_KINDS`).
            ...meta.dynamicImports.filter(
              (s) => !isBrowserUnreachableDynamic(s),
            ),
          ],
        });
      }
      // Artifacts whose files a chunk addresses by URL (images, workers).
      for (const dirName of linked.record.assetDirs) {
        links.push({
          linkName: dirName,
          storePath: artifactStorePath(dirName),
        });
      }

      // Map entries: vendors and hosts — assembled by the same helper the
      // map-in-sync check recomputes with, so the two cannot drift.
      const mapEntries: ImportMapEntry[] = composeMapEntries({
        vendorMeta: vendors,
        hosts: composedHosts,
        pageScripts: linked.record.pageScripts,
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
        for (const l of workerTree.linked) {
          links.push({
            linkName: l,
            storePath: artifactStorePath(l),
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

      const entryUrl = linked.record.entryUrl;
      const preloadSeeds = linked.record.bootSeeds;
      // The boot's priority batch per app: the chunks of every deferred plugin
      // under the app's root (the same partition web-core's App.tsx loads by).
      const appPreloadSeeds = linked.record.appSeeds;

      if (crawl !== null) {
        links.push({
          linkName: crawl.dirName,
          storePath: artifactStorePath(crawl.dirName),
        });
      }

      const central = await centralBuild;
      if (!central.ok) throw central.error;
      const { importMap, preloads, graphHash } = composeDist({
        stagingDir: opts.stagingDir,
        webSrcDir,
        buildId: opts.buildId,
        buildCommit: opts.buildCommit,
        centralBuild: central.build,
        minify: opts.minify,
        cssHref: css.href,
        links,
        materialize: opts.materialize,
        addressDir: opts.addressDir,
        mapEntries,
        staticImportsByUrl,
        emitted,
        entryUrl,
        preloadSeeds,
        appPreloadSeeds,
        link: {
          key: linked.record.key,
          entryUrl,
          pageScripts: linked.record.pageScripts,
        },
        edges: Object.fromEntries(
          [...buildOut.metas].map(([dirName, meta]) => [
            dirName,
            edgesOf(meta),
          ]),
        ),
      });
      if (crawl !== null) {
        const staged = stageCrawlSnapshot({
          stagingDir: opts.stagingDir,
          dirName: crawl.dirName,
          materialize: opts.materialize ?? false,
        });
        log(`crawl snapshot: staged ${staged.join(", ")} into the dist`);
      }
      // The shell's own files (index.html, public/): every other served file
      // came out of a cache entry published with its sidecars.
      await precompressFiles(
        readdirSync(opts.stagingDir, { withFileTypes: true })
          .filter((d) => d.isFile())
          .map((d) => joinAppPath(opts.stagingDir, d.name)),
      );

      // Ground truth: re-scan the STAGED module files themselves (through the
      // store symlinks) — independent of the builders' meta.json, so a scanner
      // blind spot cannot blind this gate too. Verifies both specifier
      // resolution and the linkage of every bound name: an importer is reused
      // from the store unrebuilt when its target changes, so this is the only
      // place the composed fleet's bytes are ever read against each other.
      const groundTruth = await scanStagedModules({
        stagingDir: opts.stagingDir,
        imports: importMap.imports,
        // An asset dir is linked for its files, not its modules: those
        // reach the page bundled into the chunks scanned here.
        linkNames: links
          .map((l) => l.linkName)
          .filter((n) => !linked.record.assetDirs.includes(n)),
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
      return { preloads, graphHash, linkNames: links.map((l) => l.linkName) };
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
    linkNames: composed.linkNames,
  };
}
