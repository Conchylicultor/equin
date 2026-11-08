import { createHash } from "node:crypto";
import {
  lstat,
  readFile,
  realpath,
  stat,
} from "@plugins/packages/plugins/timed-fs/core";
import { builtinModules } from "node:module";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { yieldMacrotask } from "@plugins/packages/plugins/macrotask-yield/core";
import { runTracked } from "@plugins/infra/plugins/runtime-profiler/core";
import { allSourceSets, type ClosureSince, type SourceSet } from "../core";
import {
  createImportResolver,
  UnresolvedImportError,
  type ImportResolver,
  type Resolution,
} from "./resolve";

// The digest of a source set: sha256 over the static runtime import closure of
// its modules, as the Bun runtime would load it.
//
// - Imports are read with Bun's own transpiler (`scanImports`), so a type-only
//   import — erased before anything runs — is no edge, and resolved by
//   `./resolve` (async, the runtime's answer for what this repo imports, the
//   tsconfig `@plugins/*` paths included; it refuses what it cannot answer
//   exactly). A dynamic `import("…")` with a literal path counts too.
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

/** The name of the package whose real directory (under `node_modules`) is `dir`. */
function packageNameAt(dir: string): string {
  const at = dir.lastIndexOf(NODE_MODULES) + NODE_MODULES.length;
  const segments = dir.slice(at).split(sep);
  return segments[0]!.startsWith("@")
    ? `${segments[0]}/${segments[1]}`
    : segments[0]!;
}

// `name@version` of the package at `dir`, memoized per package dir within one
// closure walk (a closure reaches one package from many files).
function packageIdOf(
  dir: string,
  packageIds: Map<string, Promise<string>>,
): Promise<string> {
  const name = packageNameAt(`${dir}${sep}`);
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
 * What a closure walk reports, as it goes: every import that leaves the repo
 * for a package, every builtin. Each repo file is handed to `facts`, which
 * answers its imports (reading the file, or not); the walk itself — what an
 * edge is, what resolves where, what refuses — is ONE function, so the digest
 * and {@link closureChangedSince} cannot disagree on what a closure holds.
 */
interface ClosureVisitor {
  /** The imports of the repo file `path` (and whatever the visitor records of it). */
  facts(path: string): Promise<FileFacts>;
  /** An import that resolved to a package (its `node_modules` entry and real directory). */
  package(pkg: Extract<Resolution, { kind: "package" }>): Promise<void>;
  builtin(specifier: string): void;
}

/** What a file's bytes say about its loads: its literal import specifiers (none for a non-module file). */
interface FileFacts {
  imports: readonly string[];
}

/**
 * A file's facts, read from its bytes. Refuses (throws) a module with a load
 * the scan cannot see, so the facts of a file are only ever a closure's whole
 * story of it.
 */
function scanFacts(file: string, bytes: Buffer): FileFacts {
  if (!CODE_FILE.test(file)) return { imports: [] };
  const transpiler = transpilerFor(file);
  const text = bytes.toString("utf8");
  const imports = transpiler.scanImports(text);
  assertEveryImportSeen(file, transpiler, text, imports);
  return { imports: imports.map((i) => i.path) };
}

/**
 * A file's identity as the kernel stamps it: an inode keeps this stamp exactly
 * as long as it keeps its bytes — every write, truncate or rename-into-place
 * moves the change time (or the inode), and nothing in user space sets a change
 * time back (`closureChangedSince` explains why the judgement rests on it).
 */
function stampOf(s: { ino: number; size: number; ctimeMs: number }): string {
  return `${s.ino}:${s.size}:${s.ctimeMs}`;
}

/**
 * Every repo file this process has scanned, by path: its facts and the stamp
 * its bytes had when they were read. A file whose stamp is unchanged has those
 * same bytes, so its facts are reused instead of read again — a closure walk
 * reads only what changed since this process last looked (O(closure) stats,
 * O(changed files) reads). Never a verdict: every walk still visits, stats and
 * re-resolves every file, so a new file shadowing an import, a re-pointed
 * package or a moved file is seen exactly as by a first walk. Bounded by the
 * repo files a closure of this process reaches.
 */
const scanned = new Map<string, { stamp: string; facts: FileFacts }>();

/**
 * Read `path` and scan it. Its facts are remembered only under a stamp the
 * file held both before and after the read: a write landing during the read
 * moves the stamp, and the facts of bytes that may be the old ones are then
 * not tied to the new stamp. Hands back the bytes and the stat taken AFTER the
 * read (so a write during the read is seen) for a caller that judges it.
 */
async function readFacts(
  path: string,
  before?: { ino: number; size: number; ctimeMs: number },
): Promise<{
  bytes: Buffer;
  after: { ctimeMs: number };
  facts: FileFacts;
}> {
  const prior = before ?? (await stat(path));
  const bytes = await readFile(path);
  const facts = scanFacts(path, bytes);
  const after = await stat(path);
  const stamp = stampOf(after);
  if (stamp === stampOf(prior)) scanned.set(path, { stamp, facts });
  else scanned.delete(path);
  return { bytes, after, facts };
}

/**
 * How many files a walk asks about at once. Awaited one at a time, a warm
 * walk of a backend's closure (5,371 files) spent 128 ms on stats that cost
 * 14 ms 64 at a time — and yielded 5,371 times on the serving thread, so
 * every unrelated task the backend ran in between landed inside the walk
 * (the adopt answer was 0.15 or 0.6 s by luck). The stats themselves are the
 * floor; only a change signal removes them.
 */
const WALK_BATCH = 64;

type Edge = Resolution | { builtin: string };

/** A resolver refusal, as the closure refusal every caller reads. */
function unmeasurable(err: unknown): never {
  if (!(err instanceof UnresolvedImportError)) throw err;
  throw new UnmeasurableClosureError(`[source-digest] ${err.message}`, {
    cause: err,
  });
}

// One import's edge. Always a promise, so a refusal never leaves the batch's
// other edges unawaited (a synchronous throw mid-`map` would).
async function edgeOf(
  resolver: ImportResolver,
  specifier: string,
  file: string,
): Promise<Edge> {
  if (isBuiltin(specifier)) return { builtin: specifier };
  try {
    return await resolver.resolve(specifier, file);
  } catch (err) {
    unmeasurable(err);
  }
}

async function walkClosure(
  entries: readonly string[],
  visit: ClosureVisitor,
): Promise<void> {
  // One resolver per walk: its directory listings are this walk's view of the
  // tree, so a later walk sees a file added since (a new shadowing match).
  const resolver = createImportResolver();
  // Real paths, as every resolved path is: one file, one identity.
  const seen = new Set<string>(
    await Promise.all(entries.map((e) => realpath(e))),
  );
  // Breadth-first, a batch of one level at a time: each file's facts, then
  // its edges. Every file is still visited once and every import resolved.
  let level = [...seen];
  while (level.length > 0) {
    const next: string[] = [];
    for (let i = 0; i < level.length; i += WALK_BATCH) {
      const batch = level.slice(i, i + WALK_BATCH);
      const facts = await Promise.all(batch.map((file) => visit.facts(file)));
      const edges = await Promise.all(
        batch.flatMap((file, j) =>
          facts[j]!.imports.map((specifier) =>
            edgeOf(resolver, specifier, file),
          ),
        ),
      );
      // Asked once the batch resolved, so a refusal leaves none unawaited;
      // in import order, so a walk's order does not depend on I/O timing.
      const packages: Extract<Resolution, { kind: "package" }>[] = [];
      for (const edge of edges) {
        if ("builtin" in edge) visit.builtin(edge.builtin);
        else if (edge.kind === "package") packages.push(edge);
        else if (!seen.has(edge.path)) {
          seen.add(edge.path);
          next.push(edge.path);
        }
      }
      await Promise.all(packages.map((p) => visit.package(p)));
      // One batch at a time on the serving thread: let timers and I/O run.
      await yieldMacrotask();
    }
    level = next;
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
    // The digest hashes every byte, so it always reads; what it scans is
    // remembered for a later `closureChangedSince` of the same files.
    async facts(path) {
      const { bytes, facts } = await readFacts(path);
      closure.files.set(path, sha256(bytes));
      return facts;
    },
    async package(pkg) {
      closure.packages.add(await packageIdOf(pkg.dir, packageIds));
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
 * Read per file: the repo file's stat. Its bytes are read (and stat'd again
 * AFTER, so a write during the read is seen) only when this process has not
 * yet scanned the file under its present stamp — a file whose stamp is
 * unchanged holds the bytes it was scanned with, so a walk after the first
 * reads only what changed. Every file is still visited and every import
 * resolved again, so a new file shadowing a resolution counts as it did.
 *
 * Per package import: the `node_modules/<name>` entry resolution goes through
 * — the first that exists
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
      // Stat first: a file changed since the instant fails the walk before
      // anything is read. One whose stamp is the one its facts were read
      // under holds those same bytes — its facts are reused, not read again.
      async facts(path) {
        files.add(path);
        checked.add(path);
        const before = await stat(path);
        if (before.ctimeMs >= sinceMs) {
          throw new ChangedSince(path, before.ctimeMs);
        }
        const known = scanned.get(path);
        if (known !== undefined && known.stamp === stampOf(before)) {
          return known.facts;
        }
        const { after, facts } = await readFacts(path, before);
        if (after.ctimeMs >= sinceMs) {
          throw new ChangedSince(path, after.ctimeMs);
        }
        return facts;
      },
      async package(pkg) {
        await assertBefore(pkg.entry, lstat);
        await assertBefore(join(pkg.dir, "package.json"), stat);
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
