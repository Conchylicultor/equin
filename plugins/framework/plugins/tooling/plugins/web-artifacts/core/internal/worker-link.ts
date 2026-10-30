// The browser host's worker loads the same per-plugin artifacts the page does,
// through a LINK TREE instead of an import map (import maps do not reach
// workers): a store entry `worker-tree.<hash>` holding one symlink per artifact
// in the hosts' closures, `<plugin-id>.<kind>` → its linked copy, and `_vendor`
// → the vendor set. Its hash combines exactly those names and targets, so a
// running worker never sees a tree change under it: a new build is a new tree,
// served beside the old one (carried forward like any `artifacts/<name>` link),
// and the page reaches it through the import map
// (`@browser-host-worker/<pluginPath>`).
//
// An artifact's bytes name their dependencies by bare specifier
// (`@plugins/<p>/<folder>`, `zod`). Its LINKED copy names them by a relative
// URL into the tree, spelled from the specifier alone — stable names, never a
// content hash. So the linked copy is a pure function of the artifact's own
// bytes: published once per artifact address into the store
// (`<dirName>.worker`), shared by every worktree, and a dependency's rebuild
// never changes its importers' linked bytes. Compose lays the tree out as
// symlinks to those entries, and the staged verify resolves every relative
// import through them.
//
// What the worker can never load is spelled as a module that throws when
// loaded: a browser host's own `@browser-host/*` (a worker never starts one —
// a scenario module the closure carries names it), and a browser-unreachable
// leaf barrel's dynamic import. Anything else unmappable fails the link: a
// composition specifier, an npm specifier the vendor set lacks. (A platform
// API never gets here: the host stage refuses it per artifact, before the
// vendor set is built — `assertPortableArtifacts`.)

import { createHash } from "node:crypto";
import {
  linkSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative, sep } from "node:path";
import { init as esInit, parse as esParse } from "es-module-lexer/minimal";
import { isBrowserHostSpecifier } from "../browser-host-specifier";
import { COMPOSITION_SPECIFIERS } from "../composition-modules";
import {
  isBrowserUnreachableDynamic,
  WORKER_LINKED_SUFFIX,
  WORKER_TREE_PREFIX,
} from "../constants";
import { cobuildHostOf } from "../own-roots";
import {
  artifactStorePath,
  artifactTmpDir,
  hasArtifact,
  publishDir,
  readArtifactMeta,
  touchArtifact,
  type ArtifactMeta,
} from "./store";

/** The vendor set's link inside a worker tree. */
const VENDOR_LINK = "_vendor";

/** The tree-relative link name of a plugin's `kind` artifact: `<plugin-id>.<kind>`. */
export function workerLinkName(pluginPath: string, kind: string): string {
  return `${pluginPath.split("/plugins/").join(".")}.${kind}`;
}

/** The store entry holding the linked copy of artifact `dirName`. */
export function workerLinkedDirName(dirName: string): string {
  return `${dirName}${WORKER_LINKED_SUFFIX}`;
}

/**
 * The tree-relative file a `@plugins/<path>/<folder>` specifier names: the
 * folder's own artifact's `index.js`, or — for a co-built folder — its file
 * inside the host kind's artifact (`exhibits` → `<id>.web/exhibits.js`).
 */
export function workerFileOf(spec: string): string {
  const rel = spec.slice("@plugins/".length);
  const slash = rel.lastIndexOf("/");
  if (!spec.startsWith("@plugins/") || slash <= 0) {
    throw new Error(`worker link: "${spec}" is not a folder-barrel specifier`);
  }
  const pluginPath = rel.slice(0, slash);
  const folder = rel.slice(slash + 1);
  const host = cobuildHostOf(folder);
  return host === null
    ? `${workerLinkName(pluginPath, folder)}/index.js`
    : `${workerLinkName(pluginPath, host)}/${folder}.js`;
}

/** A module that throws `message` when the worker loads it. */
function throwingModule(message: string): string {
  return `data:text/javascript,${encodeURIComponent(
    `throw new Error(${JSON.stringify(message)});`,
  )}`;
}

/**
 * What one import of a linked file becomes. `up` is the relative path from the
 * importing file back to the tree root (`../`, `../../`, …). Relative specifiers
 * stay as they are: they name files inside the same artifact.
 */
export function linkSpecifier(opts: {
  spec: string;
  dynamic: boolean;
  up: string;
  vendorEntries: Readonly<Record<string, string>>;
  importer: string;
}): string {
  const { spec, up } = opts;
  if (spec.startsWith(".") || spec.startsWith("/") || spec.startsWith("data:"))
    return spec;
  if (isBrowserHostSpecifier(spec)) {
    return throwingModule(
      `${spec}: a browser host's worker does not start a browser host`,
    );
  }
  if (spec.startsWith("@plugins/")) {
    if (opts.dynamic && isBrowserUnreachableDynamic(spec)) {
      return throwingModule(`${spec}: not loadable in a browser`);
    }
    return `${up}${workerFileOf(spec)}`;
  }
  if (COMPOSITION_SPECIFIERS.has(spec)) {
    throw new Error(
      `worker link: ${opts.importer} imports "${spec}", which only the page's import map serves`,
    );
  }
  const file = opts.vendorEntries[spec];
  if (file === undefined) {
    throw new Error(
      `worker link: ${opts.importer} imports "${spec}", which the vendor set does not carry`,
    );
  }
  return `${up}${VENDOR_LINK}/${file}`;
}

/** Rewrite every import of one module's source; `null` when nothing changed. */
export function linkModuleSource(
  source: string,
  name: string,
  rewrite: (spec: string, dynamic: boolean) => string,
): string | null {
  const [imports] = esParse(source, name);
  let out = "";
  let last = 0;
  for (const imp of imports) {
    if (imp.n === undefined || imp.d === -2) continue; // non-literal, import.meta
    const dynamic = imp.d > -1;
    const next = rewrite(imp.n, dynamic);
    if (next === imp.n) continue;
    const raw = source.slice(imp.s, imp.e);
    // A dynamic import's range covers its quotes; a static one's does not.
    const quoted = raw.startsWith('"') || raw.startsWith("'");
    out += source.slice(last, imp.s) + (quoted ? JSON.stringify(next) : next);
    last = imp.e;
  }
  return last === 0 ? null : out + source.slice(last);
}

const MODULE_RE = /\.m?js$/;
const SIDECAR_RE = /\.(br|gz)$/;

/**
 * Ensure the linked copy of artifact `dirName` is in the store; return its
 * store dir name. Unchanged files (and their precompressed sidecars) are hard
 * links to the artifact's own; a rewritten module gets fresh sidecars.
 */
export async function ensureWorkerLinked(opts: {
  dirName: string;
  vendorEntries: Readonly<Record<string, string>>;
}): Promise<string> {
  const linked = workerLinkedDirName(opts.dirName);
  if (hasArtifact(linked)) {
    touchArtifact(linked);
    return linked;
  }
  await esInit();
  const src = artifactStorePath(opts.dirName);
  const tmp = artifactTmpDir(linked);
  const precompressed = new Set<string>();
  for (const dirent of readdirSync(src, {
    recursive: true,
    withFileTypes: true,
  })) {
    if (!dirent.isFile()) continue;
    const abs = join(dirent.parentPath, dirent.name);
    const rel = relative(src, abs);
    if (rel === "meta.json" || SIDECAR_RE.test(rel)) continue;
    const dest = join(tmp, rel);
    mkdirSync(dirname(dest), { recursive: true });
    // The tree root, seen from this file: one `..` per dir level plus the
    // artifact's own link dir.
    const up = "../".repeat(rel.split(sep).length);
    const rewritten = MODULE_RE.test(rel)
      ? linkModuleSource(
          readFileSync(abs, "utf8"),
          `${opts.dirName}/${rel}`,
          (spec, dynamic) =>
            linkSpecifier({
              spec,
              dynamic,
              up,
              vendorEntries: opts.vendorEntries,
              importer: `${opts.dirName}/${rel}`,
            }),
        )
      : null;
    if (rewritten !== null) {
      writeFileSync(dest, rewritten);
      continue;
    }
    linkSync(abs, dest);
    for (const ext of [".br", ".gz"]) {
      try {
        linkSync(`${abs}${ext}`, `${dest}${ext}`);
        precompressed.add(dest);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      }
    }
  }
  await publishDir({
    tmpDir: tmp,
    dest: artifactStorePath(linked),
    meta: readArtifactMeta(opts.dirName),
    isComplete: () => hasArtifact(linked),
    precompressed,
  });
  return linked;
}

/** A worker tree: its store entry and the links it holds. */
export interface WorkerTree {
  dirName: string;
  /** link name → absolute store path */
  links: Record<string, string>;
}

/**
 * The tree linking `linked` (artifact link name → linked store entry) and the
 * vendor set at `vendorSetDir`. Pure: its name is a hash of its links.
 */
export function workerTreeOf(opts: {
  linked: ReadonlyArray<{ linkName: string; linkedDirName: string }>;
  vendorSetDir: string;
}): WorkerTree {
  const links: Record<string, string> = {};
  for (const { linkName, linkedDirName } of opts.linked) {
    const target = artifactStorePath(linkedDirName);
    if (links[linkName] !== undefined && links[linkName] !== target) {
      throw new Error(
        `worker tree: ${linkName} names two artifacts (${links[linkName]}, ${target})`,
      );
    }
    links[linkName] = target;
  }
  links[VENDOR_LINK] = opts.vendorSetDir;
  const sorted = Object.keys(links).sort();
  const hash = createHash("sha256")
    .update(sorted.map((k) => `${k}\t${basename(links[k]!)}`).join("\n"))
    .digest("hex");
  return {
    dirName: `${WORKER_TREE_PREFIX}${hash.slice(0, 16)}`,
    links: Object.fromEntries(sorted.map((k) => [k, links[k]!])),
  };
}

/** Ensure the tree's store entry exists (a dir of symlinks); return its path. */
export async function ensureWorkerTree(tree: WorkerTree): Promise<string> {
  if (hasArtifact(tree.dirName)) {
    touchArtifact(tree.dirName);
    return artifactStorePath(tree.dirName);
  }
  const tmp = artifactTmpDir(tree.dirName);
  for (const [name, target] of Object.entries(tree.links)) {
    symlinkSync(target, join(tmp, name));
  }
  await publishDir({
    tmpDir: tmp,
    dest: artifactStorePath(tree.dirName),
    meta: { workerTree: Object.keys(tree.links) },
    isComplete: () => hasArtifact(tree.dirName),
  });
  return artifactStorePath(tree.dirName);
}

/**
 * The "no Node builtins" gate, per artifact: a worker artifact importing a
 * platform API (a Node builtin, `bun:*`, a platform package — boundaries'
 * `isPlatformApi`, handed in by the pipeline's caller) fails the build, naming
 * it. A browser host boots portable code only.
 */
export function assertPortableArtifacts(
  metas: ReadonlyArray<{ dirName: string; meta: ArtifactMeta }>,
  isPlatformApi: (specifier: string) => boolean,
): void {
  const offenders: string[] = [];
  for (const { dirName, meta } of metas) {
    const specs = new Set([
      ...Object.values(meta.staticImportsByFile).flat(),
      ...meta.dynamicImports,
    ]);
    for (const spec of specs) {
      if (isPlatformApi(spec)) offenders.push(`${dirName} imports "${spec}"`);
    }
  }
  if (offenders.length > 0) {
    throw new Error(
      `browser host: worker artifacts reach platform APIs — a browser host boots portable code only:\n  ${offenders.join("\n  ")}`,
    );
  }
}
