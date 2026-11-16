// Crawl snapshots: the static HTML a crawlable composition's dist carries for
// robots (`apps/website/crawlable`, research/2026-11-10-global-website-crawlable-v3.md).
// Only a composition declared `crawlable: true` gets one — the build CLI
// passes `crawl` for it, so main's build and an ordinary worktree's never
// reach this stage's work.
//
// The take is ONE script in the repo, `plugins/<p>/bin/static-host.ts`
// (`discoverStaticHostTake`; codegen's static-host-gen writes its graphs
// beside it). It runs once per address in a fresh Bun process —
// `static-host.ts <composition> <out-dir> <cluster>` — booting the
// composition's portable server graph in-process on PGlite (opened from the
// initialized cluster `host-snapshots.ts` shares), rendering every page its
// server declares through the composition's web plugins, and writing the
// files it adds to the dist (`snapshot/manifest.json` and its fragments)
// under `<out-dir>`. Published as one store entry; compose links each of its
// top-level entries into the dist root.
//
// The address covers everything that can change those bytes, derived, never
// listed:
//   - the code: the Merkle keys, in the plugin-records module graph (static
//     AND dynamic edges), of the take script — its generated listing's
//     `import()` thunks reach every server barrel it boots — of every web
//     barrel the take renders with (its listing's `webPlugins` for the
//     composition: read from the listing itself, so the address keys exactly
//     what the take loads, and the build and `crawlable:static-take` compute
//     the same one), and of every
//     web barrel in the take's own plugin subtree: the render half
//     (`crawlable/snapshot-render`), build-only and so in no composition.
//     Both are loaded through barrel-import, an edge no graph sees;
//   - the data that code reads off disk: every file under a glob root any
//     module of that graph declares — the bundled migration and config
//     providers' roots (`data/*.sql`, `/config/**`), which the take's disk
//     swaps read in their place. The swap applies exactly to a bundled
//     provider the take's graph boots, so the files it reads are always under
//     a root of that graph. Every file is read off the build's RepoSnapshot:
//     the WORKING TREE (a modified file hashed as it is on disk, an untracked
//     one included), so a dirty edit to config/ moves the address the take
//     publishes under — the take reads the same bytes;
//   - what runs it: the npm resolutions, `patches/`, the Bun version, the
//     initialized cluster's address, the composition's name and this stage's
//     layout.

import { createHash } from "node:crypto";
import { rmSync, symlinkSync, cpSync } from "node:fs";
import {
  joinAppPath,
  type AppPath,
} from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import type { RepoSnapshot } from "@plugins/framework/plugins/tooling/core";
import {
  existsSync,
  readdirSync,
} from "@plugins/packages/plugins/timed-fs/core";
import { spawnCaptured } from "@plugins/infra/plugins/spawn/core";
import {
  buildModuleGraph,
  currentRecordStore,
  NO_OUTSIDE_FILES,
} from "@plugins/plugin-meta/plugins/plugin-records/core";
import { lockfileNpmResolutions } from "@plugins/infra/plugins/deps/plugins/npm/plugins/lock-resolutions/core";
import {
  artifactDirName,
  artifactStorePath,
  artifactTmpDir,
  ensureStoreDirs,
  hasArtifact,
  loadGlobPatternMemo,
  publishArtifact,
  touchArtifact,
  type ArtifactMeta,
} from "./store";
import { globFilesOfModules, type OwnSources } from "./own-files";
import { openBuildLease } from "./lease";
import { ensurePgliteCluster, pgliteClusterDirName } from "./host-snapshots";

/** Where the one static-host take sits inside its plugin. */
export const STATIC_HOST_ENTRY_REL = "bin/static-host.ts";

/** The take's generated listing (codegen's static-host-gen), beside it. */
const STATIC_HOST_LISTING = "static-host.generated.ts";

const TAKE_RE = /^plugins\/((?:[^/]+\/plugins\/)*[^/]+)\/bin\/static-host\.ts$/;

/** The repo's static-host take: its plugin and script, or null when none; two throw. */
export function discoverStaticHostTake(
  files: Iterable<string>,
): { pluginPath: string; entry: string } | null {
  const found: { pluginPath: string; entry: string }[] = [];
  for (const path of files) {
    const m = TAKE_RE.exec(path);
    if (m !== null) found.push({ pluginPath: m[1]!, entry: path });
  }
  if (found.length > 1) {
    throw new Error(
      `two static-host takes (${found.map((f) => f.entry).join(", ")}): a crawlable composition's snapshot is taken by exactly one ${STATIC_HOST_ENTRY_REL}`,
    );
  }
  return found[0] ?? null;
}

/** Bumped when what a crawl snapshot dir holds, or how its take is run, changes shape. */
const CRAWL_LAYOUT = "2";

/** A web barrel, at any depth of a plugin subtree. */
const OWN_WEB_BARREL_RE = /(^|\/)web\/index\.ts$/;

/** How long one take may run (a boot of the composition's graph plus every page). */
const TAKE_TIMEOUT_MS = 10 * 60_000;

/** Files in a published entry that are the store's, never the dist's. */
const STORE_OWN_FILES = new Set(["meta.json"]);

/** Where bun reads `patchedDependencies`' patches. */
const PATCHES_DIR = "patches";

/**
 * The store dir of `composition`'s crawl snapshot in this tree: its address
 * over everything that can change its bytes (see the header).
 */
export async function crawlSnapshotDirName(opts: {
  root: AppPath;
  sources: OwnSources;
  composition: string;
  clusterDirName: string;
}): Promise<{ dirName: string; take: string }> {
  const repo: RepoSnapshot = opts.sources.snapshot;
  const take = discoverStaticHostTake(repo.all());
  if (take === null) {
    throw new Error(
      `crawl snapshot "${opts.composition}": the composition is crawlable, but the tree has no ${STATIC_HOST_ENTRY_REL} to take it with`,
    );
  }
  const webPlugins = await takeWebPlugins(
    opts.root,
    take.entry,
    opts.composition,
  );
  const webBarrels = webPlugins.map((p) => `plugins/${p}/web/index.ts`).sort();
  for (const b of webBarrels)
    if (!repo.has(b))
      throw new Error(`crawl snapshot "${opts.composition}": no ${b}`);
  // The take's own build-only web code (its render half): every web barrel
  // under the take's plugin, which it loads by path.
  const ownWeb = repo
    .under(`plugins/${take.pluginPath}`)
    .filter((f) => OWN_WEB_BARREL_RE.test(f))
    .sort();
  const entries = [take.entry, ...new Set([...webBarrels, ...ownWeb].sort())];
  const graph = await buildModuleGraph(
    {
      snapshot: repo,
      store: currentRecordStore(),
      readOutside: NO_OUTSIDE_FILES,
    },
    entries,
  );
  for (const [path, node] of graph.modules)
    if (node.unresolved.length > 0)
      throw new Error(
        `crawl snapshot "${opts.composition}": ${path} imports ${node.unresolved.map((u) => JSON.stringify(u)).join(", ")}, which resolves to no file of the tree — the snapshot's address cannot cover the code it loads`,
      );
  const h = createHash("sha256");
  h.update(`layout\t${CRAWL_LAYOUT}\n`);
  h.update(`composition\t${opts.composition}\n`);
  h.update(`bun\t${Bun.version}\n`);
  const lock = await repo.read("bun.lock");
  if (lock === null)
    throw new Error("crawl snapshot: the tree has no bun.lock to read");
  h.update(
    `npm\t${createHash("sha256").update(lockfileNpmResolutions(lock)).digest("hex")}\n`,
  );
  for (const file of repo.under(PATCHES_DIR))
    h.update(`patch\t${file}\t${repo.blobOf(file)}\n`);
  h.update(`cluster\t${opts.clusterDirName}\n`);
  for (const entry of entries)
    h.update(`code\t${entry}\t${graph.keyOf(entry)}\n`);
  for (const file of await globFilesOfModules(
    opts.sources,
    graph.modules.keys(),
  ))
    h.update(`data\t${file}\t${repo.blobOf(file)}\n`);
  return {
    dirName: artifactDirName(
      opts.composition,
      "crawl-snapshot",
      h.digest("hex"),
    ),
    take: take.entry,
  };
}

/**
 * The web plugins the take renders `composition` with: its generated listing's
 * `staticHosts[composition].webPlugins` — the one list the take itself loads.
 * A composition the listing does not hold throws (it is not crawlable, or the
 * listing is stale: `plugins-registry-in-sync` guards that).
 */
async function takeWebPlugins(
  root: AppPath,
  take: string,
  composition: string,
): Promise<readonly string[]> {
  const listing = joinAppPath(
    root,
    take.slice(0, take.length - "static-host.ts".length) + STATIC_HOST_LISTING,
  );
  const { staticHosts } = (await import(listing)) as {
    staticHosts: Record<string, { webPlugins: readonly string[] } | undefined>;
  };
  const host = staticHosts[composition];
  if (host === undefined) {
    throw new Error(
      `crawl snapshot "${composition}": ${listing} lists no static host for it (it lists: ${Object.keys(staticHosts).join(", ") || "none"})`,
    );
  }
  return host.webPlugins;
}

/**
 * Take `composition`'s crawl snapshot from this checkout's working tree, on its
 * own — no build around it: the snapshot at the tree's address, taken unless
 * the store has it, then published, so a build of the same tree reuses it. What
 * `crawlable:static-take` runs; the build's crawl stage is the same two calls
 * inside its pipeline (its snapshot, its lease).
 */
export async function takeCrawlSnapshot(opts: {
  root: AppPath;
  /** The caller's snapshot of the tree at `root` (a check's `ctx.repo()`). */
  snapshot: RepoSnapshot;
  composition: string;
  log: (line: string) => void;
}): Promise<{ dirName: string; took: boolean }> {
  const { root, composition, log } = opts;
  ensureStoreDirs();
  const sources: OwnSources = {
    snapshot: opts.snapshot,
    globs: loadGlobPatternMemo(),
  };
  const clusterDirName = await pgliteClusterDirName(sources.snapshot);
  const { dirName, take } = await crawlSnapshotDirName({
    root,
    sources,
    composition,
    clusterDirName,
  });
  const lease = openBuildLease();
  try {
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
    return { dirName, took };
  } finally {
    await lease.release();
  }
}

/**
 * Take the crawl snapshot into `dirName` unless the store has it: run the take
 * in a fresh Bun process (its graph registers process-wide), its database
 * opening from the initialized cluster `cluster`, then publish what it wrote.
 * Returns whether it ran.
 */
export async function ensureCrawlSnapshot(opts: {
  root: AppPath;
  composition: string;
  dirName: string;
  take: string;
  /** The initialized cluster's file, written if the store lacks it (asked only for a take). */
  cluster: () => Promise<AppPath>;
  log: (line: string) => void;
  pin: (paths: readonly AppPath[]) => Promise<void>;
}): Promise<boolean> {
  const { dirName } = opts;
  await opts.pin([artifactStorePath(dirName)]);
  if (hasArtifact(dirName)) {
    touchArtifact(dirName);
    return false;
  }
  const tmp = artifactTmpDir(dirName);
  const t0 = performance.now();
  const cluster = await opts.cluster();
  const result = await spawnCaptured(
    [
      process.execPath,
      joinAppPath(opts.root, opts.take),
      opts.composition,
      tmp,
      cluster,
    ],
    { cwd: opts.root, timeoutMs: TAKE_TIMEOUT_MS },
  );
  const wrote = existsSync(tmp) ? readdirSync(tmp) : [];
  if (result.exitCode !== 0 || wrote.length === 0) {
    rmSync(tmp, { recursive: true, force: true });
    throw new Error(
      `crawl snapshot "${opts.composition}": ${opts.take} exited ${result.exitCode}${wrote.length > 0 ? "" : " without writing anything"}\n--- stdout ---\n${result.stdout}\n--- stderr ---\n${result.stderr}`,
    );
  }
  const meta: ArtifactMeta = {
    specifier: null,
    kind: "crawl-snapshot",
    pluginPath: null,
    inputsHash: dirName,
    staticImportsByFile: {},
    dynamicImports: [],
    tailwindCandidates: [],
    builtAtMs: Date.now(),
  };
  await publishArtifact(dirName, tmp, meta);
  opts.log(
    `crawl snapshot ${opts.composition}: taken in ${Math.round(performance.now() - t0)} ms (${dirName})`,
  );
  for (const line of result.stdout.split("\n"))
    if (line.trim() !== "") opts.log(`  ${line}`);
  return true;
}

/**
 * Put a crawl snapshot's files into a staged dist: each top-level entry of the
 * store dir at the dist root, as a relative link through the dist's own
 * `artifacts/<dirName>` link (compose links the entry there, which keeps it a
 * prune root) — or copied, for a materialized dist. A name the dist already
 * holds throws.
 */
export function stageCrawlSnapshot(opts: {
  stagingDir: AppPath;
  dirName: string;
  materialize: boolean;
}): string[] {
  const store = artifactStorePath(opts.dirName);
  const names = readdirSync(store).filter(
    (n) => !STORE_OWN_FILES.has(n) && !n.endsWith(".br") && !n.endsWith(".gz"),
  );
  for (const name of names) {
    const at = joinAppPath(opts.stagingDir, name);
    if (existsSync(at)) {
      throw new Error(
        `crawl snapshot: the dist already holds "${name}" — the snapshot cannot be staged over it`,
      );
    }
    if (opts.materialize) {
      cpSync(joinAppPath(store, name), at, { recursive: true });
    } else {
      symlinkSync(`artifacts/${opts.dirName}/${name}`, at);
    }
  }
  return names;
}
