// A release host's served dists: the same address dir and retention rule as a
// dev host's, so a tab keeps loading the release it booted from after a ship.
//
// A release ships its dist MATERIALIZED inside its bundle (`web/artifacts/<name>/`
// are real files), and its extraction is pruned once a later ship passes its
// gate (`deploy ship`'s activate script). Served from the extraction, every
// open tab of the replaced release lost its lazily loaded plugins at that
// moment: `/artifacts/set.<hash>/zod.js` → 404 (2026-11-17).
//
// So a release is served from a dist of its own beside the namespace's served
// dist path (`worktreeArtifacts.webDist`, the path a dev build publishes), in
// the data root, laid out the way a dev build lays it out:
//
//   <ns>/web.live.<runId>/   the release's dist minus `artifacts/`, plus
//                            `artifacts` → ../web-addresses. What the gateway's
//                            spec and the backend's WEB_DIST name, so the
//                            gateway switches frontend and backend in its ONE
//                            spec commit, as it did when both named the bundle.
//   <ns>/web-addresses/      ONE dir of every address a recently needed graph
//                            links — here the artifact's own files (hard links
//                            into the extraction where the filesystem allows,
//                            else copies), where a dev host keeps store links
//   <ns>/web-graphs/         the graph records the backend touches when a tab
//                            names its graph (this plugin's `machine/`)
//
// No `<ns>/web` link: on a release host what is served is what the gateway's
// spec names, and the caller passes it (`servedNow`).
//
// What stays is decided by the SAME rule as a dev build (`retainAddresses`):
// an address stays while a graph needing it — composed (this release), served
// (the one being replaced) or named by an open tab — was needed within a day.
// So disk is bounded by the releases tabs used recently, not by history.

import {
  copyFileSync,
  linkSync,
  mkdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { webGraphRecordsDir } from "@plugins/infra/plugins/paths/core";
import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  readlinkSync,
} from "@plugins/packages/plugins/timed-fs/core";
import {
  retainAddresses,
  servedGraphOf,
  type AddressRetentionResult,
} from "./address-retention";

/** The address dir of the served dist at `distDir` (`<dist>-addresses`). */
export function addressDirOf(distDir: string): string {
  return `${distDir}-addresses`;
}

/** The asset files a release dist was shipped with (not carried into it). */
const OWN_ASSETS_FILE = ".release-assets";

export interface ReleaseDistPublication {
  /** The release's dist: what its spec's `web` and its backend's `WEB_DIST` name. */
  dist: string;
  /** Addresses this release (and a foreign served dist, see `servedNow`) added. */
  added: number;
  /** The address-dir trim. */
  retained: AddressRetentionResult;
}

/**
 * Prepare the release whose dist is `bundleWeb` to be served for the namespace
 * whose served-dist path is `servedDist`: add its addresses to the address
 * dir, assemble its dist, and trim the address dir to what recently needed
 * graphs link. Serves nothing by itself — the caller's spec names the dist —
 * so a release that never takes over changes nothing anyone serves.
 * Idempotent: publishing a release again reuses its dist.
 *
 * The one writer of these dirs on a release host is the release's own
 * `launch` (a swap, or a boot), one at a time per ship.
 *
 * @param opts.bundleWeb the release's own `web/` (materialized, inside its extraction).
 * @param opts.servedDist the namespace's served-dist path (`worktreeArtifacts.webDist`):
 *   the address dir, the graph records and every release dist sit beside it.
 * @param opts.runId the release run, naming its dist dir; a bundle that names
 *   none (an older manifest) is named by its graph instead.
 * @param opts.servedNow the dist the gateway serves the namespace from right
 *   now (its spec's `web`), or null when nothing is served yet. Kept whatever
 *   its age (a failed ship reverts to it). One that is not a dist of this
 *   layout — a release from before it, served from its own extraction — has
 *   its addresses imported, so its open tabs survive its extraction's prune.
 */
export function publishReleaseDist(opts: {
  bundleWeb: string;
  servedDist: string;
  runId: string | undefined;
  servedNow: string | null;
}): ReleaseDistPublication {
  const { bundleWeb, servedDist } = opts;
  const graph = readGraph(bundleWeb);
  const names = materializedNames(bundleWeb);
  const parent = dirname(servedDist);
  const addressDir = addressDirOf(servedDist);
  const graphsDir = webGraphRecordsDir(servedDist);
  mkdirSync(addressDir, { recursive: true });

  // 1. This release's addresses, and a foreign served dist's.
  let added = addAddresses(bundleWeb, names, addressDir);
  const releaseDist = join(
    parent,
    `${basename(servedDist)}.live.${distId(opts.runId ?? `graph-${graph}`)}`,
  );
  const servedNow =
    opts.servedNow !== null && existsSync(opts.servedNow)
      ? opts.servedNow
      : null;
  let live: { graph: string; names: readonly string[] } | null = null;
  if (servedNow !== null && servedNow !== releaseDist) {
    if (isOwnDist(servedNow, addressDir)) {
      live = servedGraphOf({ distDir: servedNow, graphsDir });
    } else {
      const liveNames = materializedNames(servedNow);
      added += addAddresses(servedNow, liveNames, addressDir);
      live = { graph: readGraph(servedNow), names: liveNames };
    }
  }

  // 2. This release's dist: everything but `artifacts`, which is the address
  // dir. Built aside and renamed in; a dist that exists is whole (a boot after
  // this release's own swap reuses it).
  if (!existsSync(releaseDist)) {
    const staging = `${releaseDist}.tmp.${process.pid}`;
    rmSync(staging, { recursive: true, force: true });
    mkdirSync(staging);
    for (const entry of readdirSync(bundleWeb)) {
      if (entry === "artifacts") continue;
      linkTree(join(bundleWeb, entry), join(staging, entry));
    }
    symlinkSync(join("..", basename(addressDir)), join(staging, "artifacts"));
    const ownAssets = listDir(join(bundleWeb, "assets"));
    writeFileSync(join(staging, OWN_ASSETS_FILE), ownAssets.join("\n") + "\n");
    // The stylesheet and fonts are not addresses: a tab of the release being
    // replaced still fetches its fonts lazily, from `/assets/`. Carried from
    // that release only — its own files, not what it carried — so a dist
    // holds at most two releases' assets.
    if (servedNow !== null && servedNow !== releaseDist) {
      carryAssets(servedNow, staging);
    }
    renameSync(staging, releaseDist);
  }

  // 3. Trim the address dir to what recently needed graphs link.
  const retained = retainAddresses({
    addressDir,
    graphsDir,
    graph,
    names,
    live,
  });

  // 4. Drop every release dist but this one and the one served now, and what
  // a crashed publish left.
  const keep = new Set([releaseDist, servedNow]);
  const prefix = `${basename(servedDist)}.live.`;
  for (const entry of readdirSync(parent)) {
    if (!entry.startsWith(prefix) || keep.has(join(parent, entry))) continue;
    rmSync(join(parent, entry), { recursive: true, force: true });
  }
  return { dist: releaseDist, added, retained };
}

function distId(id: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(id)) {
    throw new Error(
      `publishReleaseDist: "${id}" is not a run id (a dist path must stay inside its dir)`,
    );
  }
  return id;
}

function readGraph(dist: string): string {
  const graph = readFileSync(join(dist, ".build-graph"), "utf8").trim();
  if (graph === "") {
    throw new Error(`publishReleaseDist: ${dist}/.build-graph is empty`);
  }
  return graph;
}

/** The address names a materialized dist ships (its `artifacts/` is a real dir). */
function materializedNames(dist: string): string[] {
  const artifacts = join(dist, "artifacts");
  if (!lstatSync(artifacts, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error(
      `publishReleaseDist: ${artifacts} is not a directory — a release ships its artifacts materialized`,
    );
  }
  return readdirSync(artifacts);
}

/** Whether `dist` serves its addresses through this namespace's address dir. */
function isOwnDist(dist: string, addressDir: string): boolean {
  const artifacts = join(dist, "artifacts");
  const st = lstatSync(artifacts, { throwIfNoEntry: false });
  return (
    st?.isSymbolicLink() === true &&
    readlinkSync(artifacts) === join("..", basename(addressDir))
  );
}

/**
 * Add `dist`'s absent addresses to the address dir. Write-once: an address
 * already there holds the same bytes (its name is a hash of them). Built aside
 * and renamed in, so a name present is whole.
 */
function addAddresses(
  dist: string,
  names: readonly string[],
  addressDir: string,
): number {
  let added = 0;
  for (const name of names) {
    const dest = join(addressDir, name);
    if (lstatSync(dest, { throwIfNoEntry: false })) continue;
    const tmp = `${dest}.tmp.${process.pid}`;
    rmSync(tmp, { recursive: true, force: true });
    linkTree(join(dist, "artifacts", name), tmp);
    renameSync(tmp, dest);
    added++;
  }
  return added;
}

/** Copy into `stagingDir/assets` the served release's own assets it lacks. */
function carryAssets(servedDist: string, stagingDir: string): void {
  const own = join(servedDist, OWN_ASSETS_FILE);
  // A dist not of this layout carried nothing, so all of it is its own.
  const names = existsSync(own)
    ? readFileSync(own, "utf8")
        .split("\n")
        .filter((n) => n !== "")
    : listDir(join(servedDist, "assets"));
  const assets = join(stagingDir, "assets");
  for (const name of names) {
    const src = join(servedDist, "assets", name);
    const dest = join(assets, name);
    if (!existsSync(src) || lstatSync(dest, { throwIfNoEntry: false }))
      continue;
    mkdirSync(assets, { recursive: true });
    linkTree(src, dest);
  }
}

/**
 * Recreate the tree at `src` at `dest`: directories made, symlinks re-made
 * with the same target, files hard-linked — copied when the two sit on
 * different filesystems. Every file here is write-once, so a hard link shares
 * nothing that will change, and it outlives the extraction it came from.
 */
function linkTree(src: string, dest: string): void {
  const st = lstatSync(src);
  if (st.isSymbolicLink()) {
    symlinkSync(readlinkSync(src), dest);
  } else if (st.isDirectory()) {
    mkdirSync(dest);
    for (const entry of readdirSync(src)) {
      linkTree(join(src, entry), join(dest, entry));
    }
  } else {
    try {
      linkSync(src, dest);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "EXDEV" && code !== "EPERM") throw err;
      copyFileSync(src, dest);
    }
  }
}

function listDir(dir: string): string[] {
  return existsSync(dir) ? readdirSync(dir) : [];
}
