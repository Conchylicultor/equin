import { createHash } from "node:crypto";
import { lstat, readFile, stat } from "@plugins/packages/plugins/timed-fs/core";
import { builtinModules } from "node:module";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { yieldMacrotask } from "@plugins/packages/plugins/macrotask-yield/core";
import { runTracked } from "@plugins/infra/plugins/runtime-profiler/core";
import { allSourceSets, type ClosureSince, type SourceSet } from "../core";

// The digest of a source set: sha256 over the static runtime import closure of
// its modules, as the Bun runtime would load it.
//
// - Imports are read with Bun's own transpiler (`scanImports`), so a type-only
//   import — erased before anything runs — is no edge, and resolved with
//   `Bun.resolveSync`, which reads the same tsconfig `@plugins/*` paths the
//   runtime does. A dynamic `import("…")` with a literal path counts too.
// - A repo file counts by its path RELATIVE to the closure's common ancestor
//   and its bytes, so main and a worktree running the same code agree on the
//   digest (a `host` corpus index main persists is read by every worktree).
// - A file under `node_modules` counts as its package's `name@version`, and is
//   not walked: the lockfile, not the bytes, is what moves it.
// - A builtin (`node:fs`, `bun`) counts by its specifier.
// - An import that does not resolve throws: a closure with a hole would vouch
//   for code it never read.

const CODE_FILE = /\.(?:[cm]?[jt]sx?)$/;
const BUILTINS = new Set(builtinModules);

const transpilers = {
  ts: new Bun.Transpiler({ loader: "ts" }),
  tsx: new Bun.Transpiler({ loader: "tsx" }),
  js: new Bun.Transpiler({ loader: "js" }),
  jsx: new Bun.Transpiler({ loader: "jsx" }),
};

function transpilerFor(path: string): Bun.Transpiler {
  if (path.endsWith(".tsx")) return transpilers.tsx;
  if (path.endsWith(".jsx")) return transpilers.jsx;
  if (/\.[cm]?ts$/.test(path)) return transpilers.ts;
  return transpilers.js;
}

const sha256 = (bytes: string | Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

function isBuiltin(specifier: string): boolean {
  return (
    specifier === "bun" ||
    specifier.startsWith("bun:") ||
    specifier.startsWith("node:") ||
    BUILTINS.has(specifier)
  );
}

const NODE_MODULES = `${sep}node_modules${sep}`;

/** A closure the walk cannot vouch for: a computed load, an import that does not resolve. */
class UnmeasurableClosureError extends Error {}

/** The directory of the package a resolved `node_modules` file belongs to. */
function packageDirOf(resolved: string): { name: string; dir: string } {
  const at = resolved.lastIndexOf(NODE_MODULES) + NODE_MODULES.length;
  const segments = resolved.slice(at).split(sep);
  const name = segments[0]!.startsWith("@")
    ? `${segments[0]}/${segments[1]}`
    : segments[0]!;
  return { name, dir: resolved.slice(0, at) + name.split("/").join(sep) };
}

// `name@version` of the package a resolved `node_modules` file belongs to,
// memoized per package dir within one closure walk (a closure reaches one
// package from many files).
function packageIdOf(
  resolved: string,
  packageIds: Map<string, Promise<string>>,
): Promise<string> {
  const { name, dir } = packageDirOf(resolved);
  let id = packageIds.get(dir);
  if (id === undefined) {
    id = readFile(`${dir}${sep}package.json`, "utf8").then((text) => {
      const pkg = JSON.parse(text) as { name?: unknown; version?: unknown };
      if (typeof pkg.version !== "string") {
        throw new UnmeasurableClosureError(
          `[source-digest] ${dir}${sep}package.json has no version`,
        );
      }
      return `${name}@${pkg.version}`;
    });
    packageIds.set(dir, id);
  }
  return id;
}

/** What one module's closure is made of. */
interface Closure {
  /** Absolute path → sha256 of its bytes. */
  files: Map<string, string>;
  packages: Set<string>;
  builtins: Set<string>;
}

/**
 * What a closure walk reports, as it reads: every repo file (with the bytes it
 * read), every import that leaves the repo for a package, every builtin. The
 * walk itself — what an edge is, what resolves where, what refuses — is ONE
 * function, so the digest and {@link closureChangedSince} cannot disagree on
 * what a closure holds.
 */
interface ClosureVisitor {
  file(path: string, bytes: Buffer): Promise<void> | void;
  /** `specifier`, imported by `importer`, resolved to `resolved` under `node_modules`. */
  package(importer: string, specifier: string, resolved: string): Promise<void>;
  builtin(specifier: string): void;
}

async function walkClosure(
  entries: readonly string[],
  visit: ClosureVisitor,
): Promise<void> {
  const seen = new Set<string>();
  const queue = [...entries];
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const bytes = await readFile(file);
    await visit.file(file, bytes);
    if (!CODE_FILE.test(file)) continue;
    const transpiler = transpilerFor(file);
    const text = bytes.toString("utf8");
    const imports = transpiler.scanImports(text);
    assertEveryImportSeen(file, transpiler, text, imports);
    for (const imp of imports) {
      if (isBuiltin(imp.path)) {
        visit.builtin(imp.path);
        continue;
      }
      let resolved: string;
      try {
        resolved = Bun.resolveSync(imp.path, dirname(file));
      } catch (err) {
        throw new UnmeasurableClosureError(
          `[source-digest] cannot resolve "${imp.path}" imported by ${file}`,
          { cause: err },
        );
      }
      if (resolved.includes(NODE_MODULES)) {
        await visit.package(file, imp.path, resolved);
      } else {
        queue.push(resolved);
      }
    }
    // One file at a time on the serving thread: let timers and I/O run.
    await yieldMacrotask();
  }
}

async function closureOf(entries: readonly string[]): Promise<Closure> {
  const closure: Closure = {
    files: new Map(),
    packages: new Set(),
    builtins: new Set(),
  };
  const packageIds = new Map<string, Promise<string>>();
  await walkClosure(entries, {
    file(path, bytes) {
      closure.files.set(path, sha256(bytes));
    },
    async package(_importer, _specifier, resolved) {
      closure.packages.add(await packageIdOf(resolved, packageIds));
    },
    builtin(specifier) {
      closure.builtins.add(specifier);
    },
  });
  return closure;
}

class ChangedSince extends Error {
  constructor(
    readonly path: string,
    readonly changedAtMs: number,
  ) {
    super(`[source-digest] ${path} changed at ${changedAtMs}`);
  }
}

/**
 * Whether nothing the closure of `entries` loads — or would load, followed
 * from the files on disk NOW — changed since `sinceMs`: the question a running
 * process asks to know that what it loaded (at any time after `sinceMs`, its
 * own start) is byte for byte what a process started now would load.
 *
 * "Changed" is the inode CHANGE time (`ctime`): the kernel sets it on every
 * write, rename-into-place, link or metadata change, and nothing in user space
 * sets it back, so a file whose `ctime` precedes `sinceMs` held its present
 * bytes all the way from then to the stat — whatever the content was when a
 * module was loaded, it is what is read here. A content-equal rewrite counts
 * as a change, and so does a revert: a file changed and changed back may have
 * been lazily loaded in between, so equal bytes alone vouch for nothing.
 *
 * Read per file: the repo file itself (stat AFTER its bytes are read, so a
 * write during the read is seen). Per package import: the
 * `node_modules/<name>` entry resolution goes through — the first that exists
 * walking up from the importer, as a `node_modules` lookup does — by `lstat`,
 * so a re-pointed symlink (a new inode) or a newly created shadowing entry
 * counts, plus the resolved package's `package.json`. A package's own files
 * are not walked here (as in the digest): a caller holding what it actually
 * loaded checks those itself.
 *
 * Never throws for what it measures: a closure the digest would refuse is
 * `unmeasurable`, which a caller must read as "cannot vouch".
 */
export async function closureChangedSince(
  entries: readonly string[],
  sinceMs: number,
): Promise<ClosureSince> {
  const files = new Set<string>();
  const checked = new Set<string>();
  const assertBefore = async (
    path: string,
    read: (p: string) => Promise<{ ctimeMs: number }>,
  ): Promise<void> => {
    if (checked.has(path)) return;
    checked.add(path);
    const { ctimeMs } = await read(path);
    if (ctimeMs >= sinceMs) throw new ChangedSince(path, ctimeMs);
  };
  try {
    await walkClosure(entries, {
      async file(path) {
        files.add(path);
        await assertBefore(path, stat);
      },
      async package(importer, specifier, resolved) {
        await assertBefore(await nodeModulesEntry(importer, specifier), lstat);
        await assertBefore(packageJsonOf(resolved), stat);
      },
      builtin() {},
    });
  } catch (err) {
    if (err instanceof ChangedSince) {
      return { kind: "changed", path: err.path, changedAtMs: err.changedAtMs };
    }
    if (err instanceof UnmeasurableClosureError) {
      return { kind: "unmeasurable", reason: err.message };
    }
    // A file gone between resolving it and reading it: the tree moved.
    const gone = err as NodeJS.ErrnoException;
    if (gone.code === "ENOENT" && typeof gone.path === "string") {
      return { kind: "changed", path: gone.path, changedAtMs: Date.now() };
    }
    throw err;
  }
  return { kind: "unchanged", files };
}

/** The package name a bare specifier imports (`@scope/name/sub` → `@scope/name`). */
function packageNameOf(specifier: string): string {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? `${parts[0]}/${parts[1]}` : parts[0]!;
}

/**
 * The `node_modules/<name>` entry an import of `specifier` from `importer`
 * resolves through: the first one that exists walking up from the importer's
 * directory. Throws when none does — `Bun.resolveSync` just found one, so the
 * tree moved under the walk.
 */
async function nodeModulesEntry(
  importer: string,
  specifier: string,
): Promise<string> {
  const name = packageNameOf(specifier);
  let dir = dirname(importer);
  for (;;) {
    const candidate = join(dir, "node_modules", ...name.split("/"));
    try {
      await lstat(candidate);
      return candidate;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      throw new UnmeasurableClosureError(
        `[source-digest] no node_modules entry for "${specifier}" above ${importer}`,
      );
    }
    dir = parent;
  }
}

/** The `package.json` of the package a resolved `node_modules` file belongs to. */
function packageJsonOf(resolved: string): string {
  return join(packageDirOf(resolved).dir, "package.json");
}

// A call that loads a module at runtime: `import(…)` / `require(…)`.
const DYNAMIC_LOAD = /\b(import|require)\s*\(/g;
// The same, as a stateless probe (a global regex's `test` moves the
// `lastIndex` a later `matchAll` would start from).
const HAS_DYNAMIC_LOAD = /\b(?:import|require)\s*\(/;

/**
 * Throw when the file loads a module the scan did not report — an
 * `import(x)` / `require(x)` whose path is not a literal: the digest cannot
 * follow it, so it cannot vouch for that code, and a digest that silently
 * skipped it would match code it never read. Counted on the transpiled
 * output (comments and type positions gone), so prose mentioning `import()`
 * does not count; a string literal holding one does, and fails closed. There
 * is no escape: a module that must load by computed path does it outside any
 * guarded closure (server-core's composition root, not its boot sequence).
 */
function assertEveryImportSeen(
  file: string,
  transpiler: Bun.Transpiler,
  text: string,
  imports: readonly { kind: string }[],
): void {
  const unseen = unseenLoads(transpiler, text, imports);
  for (const kind of ["import", "require"] as const) {
    if (unseen[kind] > 0) {
      throw new UnmeasurableClosureError(
        `[source-digest] ${file} has ${unseen[kind]} \`${kind}(…)\` whose path is not a literal — the digest cannot follow it, so it cannot vouch for the code it loads`,
      );
    }
  }
}

/** How many `import(…)` / `require(…)` calls of `text` the scan did not report. */
function unseenLoads(
  transpiler: Bun.Transpiler,
  text: string,
  imports: readonly { kind: string }[],
): ComputedLoads {
  // Most files hold no such call at all: no need to transpile them twice.
  if (!HAS_DYNAMIC_LOAD.test(text)) return { import: 0, require: 0 };
  const calls = { import: 0, require: 0 };
  for (const m of transpiler.transformSync(text).matchAll(DYNAMIC_LOAD)) {
    calls[m[1] as "import" | "require"]++;
  }
  return {
    import: Math.max(
      0,
      calls.import - imports.filter((i) => i.kind === "dynamic-import").length,
    ),
    require: Math.max(
      0,
      calls.require - imports.filter((i) => i.kind === "require-call").length,
    ),
  };
}

/** A module's loads the digest cannot follow, by kind. */
export interface ComputedLoads {
  import: number;
  require: number;
}

/**
 * The loads of the module at `path` (source `text`) whose path is not a
 * literal — exactly what makes {@link sourceDigest} refuse a closure holding
 * it. For a guard that keeps a closure digestable (`boot:closure-digestable`):
 * the same reading as the digest's, so the guard and the digest cannot
 * disagree on what counts.
 */
export function computedLoads(path: string, text: string): ComputedLoads {
  if (!CODE_FILE.test(path)) return { import: 0, require: 0 };
  const transpiler = transpilerFor(path);
  return unseenLoads(transpiler, text, transpiler.scanImports(text));
}

/** The deepest directory every path is under. */
function commonDir(paths: readonly string[]): string {
  let common = dirname(paths[0]!).split(sep);
  for (const p of paths.slice(1)) {
    const parts = dirname(p).split(sep);
    let i = 0;
    while (i < common.length && common[i] === parts[i]) i++;
    common = common.slice(0, i);
  }
  return common.join(sep) || sep;
}

/** The digest of the closure of `paths` (absolute module paths), computed now. */
export async function computeDigest(paths: readonly string[]): Promise<string> {
  const closure = await closureOf(paths);
  const base = commonDir([...closure.files.keys()]);
  const lines = [
    ...[...closure.files].map(([p, h]) => `file ${relative(base, p)} ${h}`),
    ...[...closure.packages].map((p) => `package ${p}`),
    ...[...closure.builtins].map((b) => `builtin ${b}`),
  ].sort();
  return sha256(lines.join("\n"));
}

type DigestResult =
  { ok: true; digest: string } | { ok: false; error: unknown };

// One digest per module set, for the life of the process: it describes the
// code this process loaded, so it is read once (as early as boot allows) and
// never again — files edited after are another process's code. Held as a
// settled result so a failed digest nobody has asked for yet is no unhandled
// rejection; every asker gets its error.
const digests = new Map<string, Promise<DigestResult>>();

function digestOf(paths: readonly string[]): Promise<DigestResult> {
  const key = paths.join("\n");
  let result = digests.get(key);
  if (result === undefined) {
    result = computeDigest(paths).then(
      (digest): DigestResult => ({ ok: true, digest }),
      (error: unknown): DigestResult => ({ ok: false, error }),
    );
    digests.set(key, result);
  }
  return result;
}

// What a digest reads of a set: a structural view, so a holder that cannot
// import this plugin (server-core's `Resource.Declare`) can carry one.
type DigestedSet = Pick<SourceSet, "description" | "urls">;

function pathsOf(sets: readonly DigestedSet[]): string[] {
  const paths = new Set<string>();
  for (const set of sets) {
    const urls = set.urls();
    if (urls.length === 0) {
      throw new Error(
        `[source-digest] the source set "${set.description}" includes no module — nothing would vouch for its code`,
      );
    }
    for (const url of urls) paths.add(fileURLToPath(url));
  }
  return [...paths].sort();
}

/**
 * The digest of the code `sets` load (hex sha256): equal for equal code
 * wherever the checkout lives, different as soon as any file their modules
 * statically reach changes, or any package they import changes version.
 * Computed once per process per module set.
 */
export async function sourceDigest(
  sets: readonly DigestedSet[],
): Promise<string> {
  const result = await digestOf(pathsOf(sets));
  if (!result.ok) throw result.error;
  return result.digest;
}

/**
 * Start digesting every set defined so far, without waiting (boot): each is
 * then read as close as possible to when its modules were imported.
 */
export function prewarmSourceDigests(): void {
  for (const set of allSourceSets()) {
    if (set.urls().length === 0) continue;
    const paths = pathsOf([set]);
    // Never rejects (a settled result), so nothing is left unhandled.
    void runTracked("source-digest:prewarm", () => digestOf(paths));
  }
}
