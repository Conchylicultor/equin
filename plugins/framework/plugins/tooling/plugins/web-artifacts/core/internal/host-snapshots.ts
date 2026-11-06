// Host snapshots: a browser host's starting state, taken once per address by
// the build (`framework/browser-server/host-storage`'s design: "A starting
// snapshot, built at build time"). A host declares one with
// `bin/browser-host.snapshot.ts` — a Bun script that boots the host's own
// graph, fills it (a demo's seed) and writes its whole state to the file it is
// given. The worker imports it as `@browser-host-snapshot/<pluginPath>`, which
// the worker tree links to the snapshot's store dir: `snapshot.bin` and an
// `index.js` exporting `{ version, takenAt, load }`.
//
// The address covers what the snapshot's DATA depends on, never the code that
// wrote it. A snapshot is a database plus store entries, and the worker boots
// TODAY's code over it — exactly as every persisted database (a desktop's, a
// browser host's kept storage) is read by code newer than the code that wrote
// it. What makes that sound is the schema and the format, so those are the
// address:
//   - the bundled data the worker inlines: every glob file of the worker
//     closure's artifacts (the migration history, the committed config) —
//     what the Bun-side script reads off disk in their place. The worker
//     refuses a snapshot whose migrations are not its bundle's, so a schema
//     change must be a new snapshot, and is;
//   - the seed's own inputs: every file of the host plugin (its seed, its
//     stories, its `data/`), nested plugins, test code, the plugin's own docs
//     and generated files (the graph's listing) excluded;
//   - the format: the npm resolutions (`lockfileNpmResolutions`: PGlite's
//     version decides the data directory's), the code of the snapshot file's
//     owner (host-storage's `core/`: the codec the worker decodes it with, the
//     load that shifts its times), this stage's layout and the module it
//     writes beside the file.
// Server code is not in it: an edit to any of the ~300 graph plugins used to
// re-run the seed (6–48 s on the host) in most builds, for data the edit did
// not change. Plugin boots stay correct over older data the way they do on
// every upgrade (definitions — views, triggers — are re-converged at boot by
// signature; rows written by older code are what any existing database holds).
// The version the worker compares is the hash of the file's bytes.
//
// Recorded measurements and the decision:
// research/2026-11-06-global-build-pipeline-step8-host-snapshot-and-cold-frontend.md.

import { createHash } from "node:crypto";
import { rmSync, writeFileSync } from "node:fs";
import { relative } from "node:path";
import {
  existsSync,
  readFileSync,
} from "@plugins/packages/plugins/timed-fs/core";
import {
  joinAppPath,
  type AppPath,
} from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import type { RepoSnapshot } from "@plugins/framework/plugins/tooling/core";
import { spawnCaptured } from "@plugins/infra/plugins/spawn/core";
import { decodeHostSnapshot } from "@plugins/framework/plugins/browser-server/plugins/host-storage/core";
import { isTestCodePath } from "@plugins/framework/plugins/plugin-id/core";
import { lockfileNpmResolutions } from "@plugins/infra/plugins/deps/plugins/npm/core";
import {
  artifactDirName,
  artifactStorePath,
  artifactTmpDir,
  hasArtifact,
  publishArtifact,
  touchArtifact,
  type ArtifactMeta,
} from "./store";
import { workerClosure, type PlannedTarget } from "./plan";

/** Where a host declares its snapshot inside its plugin. */
const HOST_SNAPSHOT_ENTRY_REL = "bin/browser-host.snapshot.ts";

/** The worker-tree link kind of a host's snapshot: `<plugin-id>.snapshot`. */
export const HOST_SNAPSHOT_LINK_KIND = "snapshot";

/** The snapshot file inside its store dir. */
const SNAPSHOT_FILE = "snapshot.bin";

/**
 * Bumped when what a snapshot dir holds, or how the script is run, changes
 * shape — the stage's own code is not in the address (see the header).
 */
const SNAPSHOT_LAYOUT = "2";

/** How long taking one snapshot may run (a boot of the whole graph plus a seed). */
const TAKE_TIMEOUT_MS = 10 * 60_000;

const slugOf = (pluginPath: string) => pluginPath.split("/plugins/").join(".");

/** Whether the host at `pluginPath` declares a snapshot. */
export function hostDeclaresSnapshot(
  repo: RepoSnapshot,
  pluginPath: string,
): boolean {
  return repo.has(`plugins/${pluginPath}/${HOST_SNAPSHOT_ENTRY_REL}`);
}

/**
 * The plugin whose code reads and writes the snapshot file (its codec, its
 * load): the file's format, so part of the address.
 */
const SNAPSHOT_FORMAT_OWNER =
  "@plugins/framework/plugins/browser-server/plugins/host-storage/core";

const CODE_FILE_RE = /\.[cm]?[jt]sx?$/;

/**
 * Whether a file of the host plugin (path relative to it) is seed input: not
 * test code, not the plugin's own docs at its root, not a generated listing.
 * Anything else — a `data/` file of any name included — is.
 */
function isSeedInput(relInPlugin: string): boolean {
  const segments = relInPlugin.split("/");
  const name = segments.at(-1)!;
  if (CODE_FILE_RE.test(name) && isTestCodePath(segments)) return false;
  if (segments.length === 1 && name.endsWith(".md")) return false;
  return !name.endsWith(".generated.ts");
}

/**
 * The store dir of the snapshot the host at `pluginPath` ships in this tree:
 * its address over what the snapshot's data depends on (see the header).
 * `closure` is the worker's artifact closure plus the host's own `core`
 * artifact's: only their glob files (the bundled data) are read.
 */
export async function hostSnapshotDirName(opts: {
  repo: RepoSnapshot;
  pluginPath: string;
  closure: readonly PlannedTarget[];
}): Promise<string> {
  const { repo, pluginPath } = opts;
  const dir = `plugins/${pluginPath}`;
  const h = createHash("sha256");
  h.update(`layout\t${SNAPSHOT_LAYOUT}\n`);
  h.update(`module\t${snapshotModuleSource({ version: "", takenAt: 0 })}\n`);
  const lock = await repo.read("bun.lock");
  if (lock === null)
    throw new Error("host snapshot: the tree has no bun.lock to read");
  h.update(
    `npm\t${createHash("sha256").update(lockfileNpmResolutions(lock)).digest("hex")}\n`,
  );
  const formatDir = `plugins/${SNAPSHOT_FORMAT_OWNER.slice("@plugins/".length)}`;
  for (const file of repo.under(formatDir)) {
    const segments = file.slice(formatDir.length + 1).split("/");
    if (isTestCodePath(segments)) continue;
    h.update(`format\t${file}\t${repo.blobOf(file)}\n`);
  }
  const bundled = new Set<string>();
  for (const t of opts.closure)
    for (const abs of t.globFiles) bundled.add(repoRel(repo, abs));
  for (const file of [...bundled].sort())
    h.update(`bundled\t${file}\t${repo.blobOf(file)}\n`);
  for (const file of repo.under(dir)) {
    const rel = file.slice(dir.length + 1);
    if (rel.startsWith("plugins/") || !isSeedInput(rel)) continue;
    h.update(`seed\t${file}\t${repo.blobOf(file)}\n`);
  }
  return artifactDirName(
    slugOf(pluginPath),
    "browser-host-snapshot",
    h.digest("hex"),
  );
}

/** `abs` (a glob file, absolute) as a path of the tree; one outside it throws. */
function repoRel(repo: RepoSnapshot, abs: string): string {
  const rel = relative(repo.root, abs);
  if (rel.startsWith("../") || !repo.has(rel))
    throw new Error(
      `host snapshot: bundled file ${abs} is not a file of the tree`,
    );
  return rel;
}

/**
 * The artifacts a host's snapshot address covers: the worker's closure, and
 * the closure of the host plugin's own `core` artifact when it has one.
 */
export function hostSnapshotClosure(opts: {
  pluginPath: string;
  workerClosure: readonly PlannedTarget[];
  targets: readonly PlannedTarget[];
  closureOf: (entry: PlannedTarget) => PlannedTarget[];
}): PlannedTarget[] {
  const own = opts.targets.find(
    (t) => t.pluginPath === opts.pluginPath && t.kind === "core",
  );
  return own === undefined
    ? [...opts.workerClosure]
    : [...opts.workerClosure, ...opts.closureOf(own)];
}

/** One host's snapshot, as the worker tree links it. */
export interface HostSnapshotLink {
  pluginPath: string;
  /** `<plugin-id>.snapshot` — what `@browser-host-snapshot/<pluginPath>` resolves under. */
  linkName: string;
  /** The snapshot's store dir. */
  linkedDirName: string;
}

/**
 * The snapshot of every host that declares one, at the address this tree
 * gives it — what the pipeline takes and links, and what `map-in-sync`
 * expects the tree to link (the same derivation, so they cannot drift).
 */
export async function hostSnapshotLinks(opts: {
  repo: RepoSnapshot;
  hosts: ReadonlyArray<{ pluginPath: string; entry: PlannedTarget }>;
  targets: readonly PlannedTarget[];
  metaOf: (dirName: string) => ArtifactMeta;
}): Promise<HostSnapshotLink[]> {
  const closureOf = (entry: PlannedTarget) =>
    workerClosure({ entry, targets: opts.targets, metaOf: opts.metaOf });
  const links: HostSnapshotLink[] = [];
  for (const h of opts.hosts) {
    if (!hostDeclaresSnapshot(opts.repo, h.pluginPath)) continue;
    links.push({
      pluginPath: h.pluginPath,
      linkName: `${slugOf(h.pluginPath)}.${HOST_SNAPSHOT_LINK_KIND}`,
      linkedDirName: await hostSnapshotDirName({
        repo: opts.repo,
        pluginPath: h.pluginPath,
        closure: hostSnapshotClosure({
          pluginPath: h.pluginPath,
          workerClosure: closureOf(h.entry),
          targets: opts.targets,
          closureOf,
        }),
      }),
    });
  }
  return links;
}

/**
 * The module the worker imports as `@browser-host-snapshot/<pluginPath>`
 * (typed by host-storage's `browser-host-snapshot.d.ts`): which snapshot it
 * is, and its bytes, fetched from beside the module.
 */
function snapshotModuleSource(facts: {
  version: string;
  takenAt: number;
}): string {
  return [
    `const url = new URL(${JSON.stringify(`./${SNAPSHOT_FILE}`)}, import.meta.url);`,
    "export default {",
    `  version: ${JSON.stringify(facts.version)},`,
    `  takenAt: ${facts.takenAt},`,
    "  async load() {",
    "    const res = await fetch(url);",
    '    if (!res.ok) throw new Error("[host-snapshot] fetching " + url + " answered " + res.status);',
    "    return new Uint8Array(await res.arrayBuffer());",
    "  },",
    "};",
    "",
  ].join("\n");
}

/**
 * Take the host's snapshot into `dirName` unless the store has it: run the
 * host's script in a fresh Bun process (its graph registers process-wide), then
 * publish the file and the module the worker imports.
 */
export async function ensureHostSnapshot(opts: {
  root: AppPath;
  pluginPath: string;
  dirName: string;
  log: (line: string) => void;
  pin: (paths: readonly AppPath[]) => Promise<void>;
}): Promise<void> {
  const { dirName } = opts;
  await opts.pin([artifactStorePath(dirName)]);
  if (hasArtifact(dirName)) {
    touchArtifact(dirName);
    return;
  }
  const tmp = artifactTmpDir(dirName);
  const out = joinAppPath(tmp, SNAPSHOT_FILE);
  const script = joinAppPath(
    opts.root,
    "plugins",
    opts.pluginPath,
    HOST_SNAPSHOT_ENTRY_REL,
  );
  const t0 = performance.now();
  const result = await spawnCaptured([process.execPath, script, out], {
    cwd: opts.root,
    timeoutMs: TAKE_TIMEOUT_MS,
  });
  if (result.exitCode !== 0 || !existsSync(out)) {
    rmSync(tmp, { recursive: true, force: true });
    throw new Error(
      `host snapshot ${opts.pluginPath}: ${HOST_SNAPSHOT_ENTRY_REL} exited ${result.exitCode}${existsSync(out) ? "" : " without writing its file"}\n--- stdout ---\n${result.stdout}\n--- stderr ---\n${result.stderr}`,
    );
  }
  const bytes = readFileSync(out);
  const version = createHash("sha256").update(bytes).digest("hex");
  const { takenAt } = decodeHostSnapshot(new Uint8Array(bytes));
  writeFileSync(
    joinAppPath(tmp, "index.js"),
    snapshotModuleSource({ version, takenAt }),
  );
  const meta: ArtifactMeta = {
    specifier: null,
    kind: "browser-host-snapshot",
    pluginPath: opts.pluginPath,
    inputsHash: dirName,
    staticImportsByFile: { "index.js": [] },
    dynamicImports: [],
    tailwindCandidates: [],
    builtAtMs: Date.now(),
  };
  await publishArtifact(dirName, tmp, meta);
  opts.log(
    `host snapshot ${opts.pluginPath}: taken in ${Math.round(performance.now() - t0)} ms (${(bytes.byteLength / 1024).toFixed(0)} KB, version ${version.slice(0, 12)}) (${dirName})`,
  );
  // What the script says about its own take (a host's boot split, …).
  for (const line of result.stdout.split("\n"))
    if (line.trim() !== "") opts.log(`  ${line}`);
}
