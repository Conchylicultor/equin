// Host snapshots: a browser host's starting state, taken once per address by
// the build (`framework/browser-server/host-storage`'s design: "A starting
// snapshot, built at build time"). A host declares one with
// `bin/browser-host.snapshot.ts` — a Bun script that boots the host's own
// graph, fills it (a demo's seed) and writes its whole state to the file it is
// given. The worker imports it as `@browser-host-snapshot/<pluginPath>`, which
// the worker tree links to the snapshot's store dir: `snapshot.bin` and an
// `index.js` exporting `{ version, takenAt, url }`.
//
// A stale snapshot has no spelling: its ADDRESS is derived from everything
// the script's output depends on, so any change to it is a new address, which
// the build takes:
//   - every artifact in the worker's closure — the server code the seed's
//     writes run through, the migrations and the committed config (both
//     inlined in their artifacts through `import.meta.glob`, so in their
//     addresses);
//   - the closure of the host plugin's own `core` artifact (the demo's data
//     modules), and every file of the host plugin itself (its `bin/` — the seed
//     and the script —, its `core/`, its `data/`), nested plugins excluded;
//   - every repo module in the script's own STATIC import closure, by content
//     (`scriptClosure`): what the Bun-side script loads that no worker
//     artifact does (its disk readers, a barrel only the seed imports);
//   - the lockfile (PGlite's version decides the data directory's format), the
//     Bun version that runs the script, and the builder identity (this code).
// The version the worker compares is the hash of the file's bytes.

import { createHash } from "node:crypto";
import { rmSync, writeFileSync } from "node:fs";
import { posix } from "node:path";
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

/** Bumped when what a snapshot dir holds changes shape. */
const SNAPSHOT_LAYOUT = "1";

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
 * The store dir of the snapshot the host at `pluginPath` ships in this tree:
 * its address over everything the snapshot depends on (see the header).
 * `closure` is the worker's artifact closure plus the host's own `core`
 * artifact's.
 */
export async function hostSnapshotDirName(opts: {
  repo: RepoSnapshot;
  pluginPath: string;
  closure: readonly PlannedTarget[];
  identityHash: string;
}): Promise<string> {
  const { repo, pluginPath } = opts;
  const dir = `plugins/${pluginPath}`;
  const h = createHash("sha256");
  h.update(`layout\t${SNAPSHOT_LAYOUT}\n`);
  h.update(`identity\t${opts.identityHash}\n`);
  h.update(`lock\t${repo.blobOf("bun.lock")}\n`);
  h.update(`bun\t${Bun.version}\n`);
  for (const file of await scriptClosure(
    repo,
    `${dir}/${HOST_SNAPSHOT_ENTRY_REL}`,
  ))
    h.update(`module\t${file}\t${repo.blobOf(file)}\n`);
  for (const name of [...new Set(opts.closure.map((t) => t.dirName))].sort())
    h.update(`artifact\t${name}\n`);
  for (const file of repo.under(dir)) {
    if (file.startsWith(`${dir}/plugins/`)) continue;
    h.update(`file\t${file}\t${repo.blobOf(file)}\n`);
  }
  return artifactDirName(
    slugOf(pluginPath),
    "browser-host-snapshot",
    h.digest("hex"),
  );
}

/** The extensions a specifier may leave off, and the index files of a folder. */
const RESOLVE_SUFFIXES = [
  "",
  ".json",
  ".ts",
  ".tsx",
  ".js",
  "/index.ts",
  "/index.tsx",
  "/index.js",
];

/**
 * Every repo module `entry` statically loads, itself included — the import
 * statements and re-exports Bun's transpiler finds (type-only imports erased),
 * followed through `@plugins/*` and relative specifiers over this tree's file
 * set. A package or builtin ends the walk (the lockfile and the Bun version
 * are in the address); a dynamic import is not followed (what the host's graph
 * loads that way is its worker's artifacts, already in the address). A repo
 * specifier resolving to no file of the tree throws: an import the address
 * cannot see would make it vouch for code it never read.
 */
async function scriptClosure(
  repo: RepoSnapshot,
  entry: string,
): Promise<string[]> {
  // The loader by extension: a `.ts` file's `<T>(x) => …` is JSX to `tsx`.
  const transpilers = {
    ts: new Bun.Transpiler({ loader: "ts" }),
    tsx: new Bun.Transpiler({ loader: "tsx" }),
    js: new Bun.Transpiler({ loader: "js" }),
  };
  const scan = (file: string, text: string) => {
    const ext = file.endsWith(".tsx")
      ? "tsx"
      : file.endsWith(".ts")
        ? "ts"
        : "js";
    try {
      return transpilers[ext].scanImports(text);
    } catch (err) {
      throw new Error(
        `host snapshot: cannot read the imports of ${file}: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    }
  };
  const seen = new Set<string>([entry]);
  const queue = [entry];
  const resolveIn = (base: string): string | null => {
    for (const suffix of RESOLVE_SUFFIXES)
      if (repo.has(`${base}${suffix}`)) return `${base}${suffix}`;
    return null;
  };
  for (const file of queue) {
    // A module's own imports; any other file it loads (a JSON) is a leaf,
    // counted by its content.
    if (!/\.(?:[cm]?[jt]sx?)$/.test(file)) continue;
    const text = await repo.read(file);
    if (text === null)
      throw new Error(`host snapshot: cannot read ${file} from the tree`);
    for (const imp of scan(file, text)) {
      if (imp.kind === "dynamic-import") continue;
      const spec = imp.path;
      let base: string;
      if (spec.startsWith("@plugins/")) base = `plugins/${spec.slice(9)}`;
      else if (spec.startsWith("."))
        base = posix.join(posix.dirname(file), spec);
      else continue;
      const resolved = resolveIn(base);
      if (resolved === null)
        throw new Error(
          `host snapshot: ${file} imports "${spec}", which resolves to no file of the tree`,
        );
      if (!seen.has(resolved)) {
        seen.add(resolved);
        queue.push(resolved);
      }
    }
  }
  return [...seen].sort();
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
  identityHash: string;
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
        identityHash: opts.identityHash,
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
}
