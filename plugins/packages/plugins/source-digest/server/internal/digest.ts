import { createHash } from "node:crypto";
import { readFile } from "@plugins/packages/plugins/timed-fs/core";
import { builtinModules } from "node:module";
import { dirname, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { yieldMacrotask } from "@plugins/packages/plugins/macrotask-yield/core";
import { runTracked } from "@plugins/infra/plugins/runtime-profiler/core";
import { allSourceSets, type SourceSet } from "../../core";

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

// `name@version` of the package a resolved `node_modules` file belongs to,
// memoized per package dir within one closure walk (a closure reaches one
// package from many files).
function packageIdOf(
  resolved: string,
  packageIds: Map<string, Promise<string>>,
): Promise<string> {
  const at = resolved.lastIndexOf(NODE_MODULES) + NODE_MODULES.length;
  const segments = resolved.slice(at).split(sep);
  const name = segments[0]!.startsWith("@")
    ? `${segments[0]}/${segments[1]}`
    : segments[0]!;
  const dir = resolved.slice(0, at) + name.split("/").join(sep);
  let id = packageIds.get(dir);
  if (id === undefined) {
    id = readFile(`${dir}${sep}package.json`, "utf8").then((text) => {
      const pkg = JSON.parse(text) as { name?: unknown; version?: unknown };
      if (typeof pkg.version !== "string") {
        throw new Error(
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

async function closureOf(entries: readonly string[]): Promise<Closure> {
  const closure: Closure = {
    files: new Map(),
    packages: new Set(),
    builtins: new Set(),
  };
  const packageIds = new Map<string, Promise<string>>();
  const queue = [...entries];
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (closure.files.has(file)) continue;
    const bytes = await readFile(file);
    closure.files.set(file, sha256(bytes));
    if (!CODE_FILE.test(file)) continue;
    const transpiler = transpilerFor(file);
    const text = bytes.toString("utf8");
    const imports = transpiler.scanImports(text);
    assertEveryImportSeen(file, transpiler, text, imports);
    for (const imp of imports) {
      if (isBuiltin(imp.path)) {
        closure.builtins.add(imp.path);
        continue;
      }
      let resolved: string;
      try {
        resolved = Bun.resolveSync(imp.path, dirname(file));
      } catch (err) {
        throw new Error(
          `[source-digest] cannot resolve "${imp.path}" imported by ${file}`,
          { cause: err },
        );
      }
      if (resolved.includes(NODE_MODULES)) {
        closure.packages.add(await packageIdOf(resolved, packageIds));
      } else {
        queue.push(resolved);
      }
    }
    // One file at a time on the serving thread: let timers and I/O run.
    await yieldMacrotask();
  }
  return closure;
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
  // Most files hold no such call at all: no need to transpile them twice.
  if (!HAS_DYNAMIC_LOAD.test(text)) return;
  const calls = { import: 0, require: 0 };
  for (const m of transpiler.transformSync(text).matchAll(DYNAMIC_LOAD)) {
    calls[m[1] as "import" | "require"]++;
  }
  const seen = {
    import: imports.filter((i) => i.kind === "dynamic-import").length,
    require: imports.filter((i) => i.kind === "require-call").length,
  };
  for (const kind of ["import", "require"] as const) {
    if (calls[kind] > seen[kind]) {
      throw new Error(
        `[source-digest] ${file} has ${calls[kind] - seen[kind]} \`${kind}(…)\` whose path is not a literal — the digest cannot follow it, so it cannot vouch for the code it loads`,
      );
    }
  }
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
