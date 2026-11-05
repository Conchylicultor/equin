import type {
  RepoFiles,
  RepoSnapshot,
} from "@plugins/framework/plugins/tooling/core";
import { gitBlobId, recordKey } from "./keys";
import type { RecordStore } from "./store";
import { relDirname, relJoin } from "./rel-path";
import { scanModuleImports, type ImportSpec } from "./scan-imports";

/**
 * The repo's module graph, read from records: each module's import specifiers
 * are a FILE fact (a function of its blob alone, stored under it), so a build
 * that changed nothing reads no source to know every barrel's closure.
 *
 * On top of it, each module's MERKLE KEY: a hash of its own blob and the keys
 * of every module it imports, so a module's key moves exactly when something it
 * can load changed. A strongly connected component (modules importing each
 * other) shares one key over all its members. This is the key an evaluated
 * record is stored under: importing a barrel is a function of the code its
 * closure loads, and of nothing else that a key can see — what escapes it (a
 * module that reads a file at load, the process environment) is what
 * `./equin check --verify-records` (main's daily plugin-records.verify) catches.
 */

/** What scanning a module yields — stored under its blob, so it must be a function of the bytes. */
interface FileFacts {
  imports: ImportSpec[];
}

// The module whose code IS the file-facts scan: the facts are keyed by its
// Merkle key (and the runtime's, whose transpiler it reads imports with), so
// editing the scan re-scans every file and nothing is bumped by hand.
const SCAN_MODULE =
  "plugins/plugin-meta/plugins/plugin-records/core/internal/scan-imports.ts";

const SCANNED = /\.(m?[jt]sx?|c[jt]s)$/;
const PLUGINS_ALIAS = "@plugins/";
// What an extensionless specifier may name, in the order the runtime tries.
const RESOLVED_EXTENSIONS = [
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".json",
];

function isInternal(spec: string): boolean {
  return (
    spec.startsWith("./") ||
    spec.startsWith("../") ||
    spec.startsWith(PLUGINS_ALIAS)
  );
}

export interface ModuleNode {
  /** Repo-relative path. */
  path: string;
  /** Its content id: the snapshot's blob, the overlay's, or one hashed from disk. */
  blob: string;
  /** The repo modules it loads with it (static imports), repo-relative. */
  staticDeps: string[];
  /** The subset of {@link staticDeps} a bundler keeps (see `ImportSpec.unused`). */
  bundledDeps: string[];
  /** The repo modules it can load later (`import()`, `require()`). */
  dynamicDeps: string[];
  /** Internal specifiers that resolve to no file — part of its key, so a file appearing moves it. */
  unresolved: string[];
}

export interface ModuleGraph {
  readonly modules: ReadonlyMap<string, ModuleNode>;
  /** The Merkle key of a module of the graph. */
  keyOf(path: string): string;
  /** Every module `path` loads with it (static imports, transitively), itself included. */
  staticClosure(path: string): Set<string>;
  /** The union of the static closures of `paths`, in one walk. */
  staticClosureOf(paths: Iterable<string>): Set<string>;
  /**
   * The union of `entries`' closures as a BUNDLER measures them (dynamic
   * imports cut, unused TypeScript imports dropped) — the shape of
   * `importClosures`: the modules, each one's out-edges, and the chain to a
   * module from the first entry reaching it.
   */
  bundledClosure(entries: readonly string[]): BundledClosure;
}

export interface BundledClosure {
  modules: Set<string>;
  children(module: string): string[];
  importChain(module: string): string[];
}

export interface ModuleGraphInput {
  /**
   * The repo's file set. A snapshot's blob ids key the file facts without a
   * read; a plain file set (a check pass's) is read, and each module's blob id
   * hashed from its content — the same graph, at the cost of the reads.
   */
  snapshot: RepoFiles | RepoSnapshot;
  /**
   * Files the build wrote after `snapshot` was taken, repo-relative → their
   * content. Their blob is computed from it, not taken from the snapshot.
   */
  written?: ReadonlyMap<string, string>;
  store: RecordStore;
  /** A file outside the snapshot (gitignored): its content from disk, or null when absent. */
  readOutside(rel: string): string | null;
}

/**
 * The graph reachable from `entries` (repo-relative), with Merkle keys. Reads
 * a module's source only when its file facts are not in the store.
 */
export async function buildModuleGraph(
  input: ModuleGraphInput,
  entries: readonly string[],
): Promise<ModuleGraph> {
  return buildGraph(input, entries, await fileFactsIdentity(input));
}

const factsIdentities = new WeakMap<object, Promise<string>>();

/** The lockfile's blob: the npm code a producer can run (a set with no blob ids: its content's). */
async function lockBlob(set: RepoFiles | RepoSnapshot): Promise<string> {
  if (!set.has("bun.lock")) return "-";
  if (typeof (set as Partial<RepoSnapshot>).blobOf === "function")
    return (set as RepoSnapshot).blobOf("bun.lock");
  const text = await set.read("bun.lock");
  if (text === null) throw new Error("[plugin-records] cannot read bun.lock");
  return gitBlobId(text);
}

/**
 * The file facts' identity over `input`'s set: the Merkle key of the scan's own
 * closure, from a graph that reads no record (its facts would need this very
 * identity) — a handful of files, scanned directly.
 */
function fileFactsIdentity(input: ModuleGraphInput): Promise<string> {
  let id = factsIdentities.get(input.snapshot);
  if (!id) {
    id = Promise.all([
      buildGraph(input, [SCAN_MODULE], null),
      lockBlob(input.snapshot),
    ]).then(([g, lock]) =>
      recordKey(
        "file-facts",
        g.keyOf(SCAN_MODULE),
        input.store.environment,
        lock,
      ),
    );
    factsIdentities.set(input.snapshot, id);
  }
  return id;
}

/** The graph; `factsId` keys its file records, or null to read and write none. */
async function buildGraph(
  input: ModuleGraphInput,
  entries: readonly string[],
  factsId: string | null,
): Promise<ModuleGraph> {
  const { snapshot, store } = input;
  const outsideContent = new Map<string, string | null>();
  const contentOutside = (rel: string): string | null => {
    let c = outsideContent.get(rel);
    if (c === undefined) {
      c = input.readOutside(rel);
      outsideContent.set(rel, c);
    }
    return c;
  };
  const exists = (rel: string): boolean =>
    input.written?.has(rel) ||
    snapshot.has(rel) ||
    contentOutside(rel) !== null;
  const hasBlobs =
    typeof (snapshot as Partial<RepoSnapshot>).blobOf === "function";
  // A plain file set's member, read once: its blob id and its scan share it.
  const memberContent = new Map<string, Promise<string | null>>();
  const readMember = (rel: string): Promise<string | null> => {
    let c = memberContent.get(rel);
    if (!c) memberContent.set(rel, (c = snapshot.read(rel)));
    return c;
  };
  const blobOf = async (rel: string): Promise<string> => {
    const w = input.written?.get(rel);
    if (w !== undefined) return gitBlobId(w);
    if (snapshot.has(rel)) {
      if (hasBlobs) return (snapshot as RepoSnapshot).blobOf(rel);
      const c = await readMember(rel);
      if (c === null)
        throw new Error(`[plugin-records] cannot read module ${rel}`);
      return gitBlobId(c);
    }
    const c = contentOutside(rel);
    if (c === null)
      throw new Error(`[plugin-records] module ${rel} does not exist`);
    return gitBlobId(c);
  };
  const resolveFrom = (fromRel: string, spec: string): string | null => {
    const base = spec.startsWith(PLUGINS_ALIAS)
      ? relJoin("plugins", spec.slice(PLUGINS_ALIAS.length))
      : relJoin(relDirname(fromRel), spec);
    if (base === null) return null;
    const candidates = [
      base,
      ...RESOLVED_EXTENSIONS.map((e) => `${base}${e}`),
      ...RESOLVED_EXTENSIONS.map((e) => `${base}/index${e}`),
    ];
    // The file set first: a probe of the disk is only for a gitignored
    // module (a generated file a barrel imports), never the common case.
    for (const c of candidates)
      if (input.written?.has(c) || snapshot.has(c)) return c;
    for (const c of candidates) if (contentOutside(c) !== null) return c;
    return null;
  };

  const modules = new Map<string, ModuleNode>();
  let level = [...new Set(entries)];
  for (const e of level)
    if (!exists(e))
      throw new Error(`[plugin-records] entry module ${e} does not exist`);
  const queued = new Set(level);
  while (level.length > 0) {
    const blobs = await Promise.all(level.map(blobOf));
    const factKey = (blob: string): string => recordKey(factsId!, blob);
    const hits = store.getMany(
      "file",
      factsId === null
        ? []
        : level.flatMap((p, i) =>
            SCANNED.test(p) ? [factKey(blobs[i]!)] : [],
          ),
    );
    const fresh: [string, string][] = [];
    const next: string[] = [];
    await Promise.all(
      level.map(async (path, i) => {
        const blob = blobs[i]!;
        let facts: FileFacts = { imports: [] };
        if (SCANNED.test(path)) {
          const k = factsId === null ? null : factKey(blob);
          const hit = k === null ? undefined : hits.get(k);
          if (hit !== undefined) facts = JSON.parse(hit) as FileFacts;
          else {
            const src =
              input.written?.get(path) ??
              (snapshot.has(path)
                ? await readMember(path)
                : contentOutside(path));
            if (src === null)
              throw new Error(`[plugin-records] cannot read module ${path}`);
            facts = { imports: scanModuleImports(src, path) };
            if (k !== null) fresh.push([k, JSON.stringify(facts)]);
          }
        }
        const node: ModuleNode = {
          path,
          blob,
          staticDeps: [],
          bundledDeps: [],
          dynamicDeps: [],
          unresolved: [],
        };
        for (const imp of facts.imports) {
          if (!isInternal(imp.spec)) continue;
          const target = resolveFrom(path, imp.spec);
          if (target === null) {
            node.unresolved.push(imp.spec);
            continue;
          }
          if (imp.dynamic) node.dynamicDeps.push(target);
          else {
            node.staticDeps.push(target);
            if (!imp.unused) node.bundledDeps.push(target);
          }
        }
        modules.set(path, node);
      }),
    );
    if (factsId !== null && fresh.length > 0) store.putMany("file", fresh);
    for (const path of level) {
      const node = modules.get(path)!;
      for (const d of [...node.staticDeps, ...node.dynamicDeps]) {
        if (queued.has(d)) continue;
        queued.add(d);
        next.push(d);
      }
    }
    level = next;
  }

  const keys = merkleKeys(modules);
  const closures = new Map<string, Set<string>>();
  const walk = (from: string[]): Set<string> => {
    const c = new Set<string>();
    const stack = [...from];
    while (stack.length > 0) {
      const p = stack.pop()!;
      if (c.has(p)) continue;
      c.add(p);
      const n = modules.get(p);
      if (!n)
        throw new Error(`[plugin-records] ${p} is not in the module graph`);
      for (const d of n.staticDeps) if (!c.has(d)) stack.push(d);
    }
    return c;
  };
  return {
    modules,
    keyOf(path) {
      const k = keys.get(path);
      if (k === undefined)
        throw new Error(`[plugin-records] ${path} is not in the module graph`);
      return k;
    },
    staticClosure(path) {
      let c = closures.get(path);
      if (!c) closures.set(path, (c = walk([path])));
      return c;
    },
    staticClosureOf: (paths) => walk([...paths]),
    bundledClosure(entries) {
      // BFS from each entry in order: the first entry reaching a module, and
      // the shortest chain from it, as the bundler's record answers.
      const parent = new Map<string, string | null>();
      for (const e of entries) {
        if (parent.has(e)) continue;
        parent.set(e, null);
        const queue = [e];
        for (const p of queue) {
          const n = modules.get(p);
          if (!n)
            throw new Error(`[plugin-records] ${p} is not in the module graph`);
          for (const d of [...new Set(n.bundledDeps)].sort()) {
            if (parent.has(d)) continue;
            parent.set(d, p);
            queue.push(d);
          }
        }
      }
      const members = new Set(parent.keys());
      const assertIn = (m: string): void => {
        if (!members.has(m))
          throw new Error(`[plugin-records] ${m} is not in the closure`);
      };
      return {
        modules: members,
        children(m) {
          assertIn(m);
          return [...new Set(modules.get(m)!.bundledDeps)].sort();
        },
        importChain(m) {
          assertIn(m);
          const chain = [m];
          for (let p = parent.get(m); p != null; p = parent.get(p))
            chain.unshift(p);
          return chain;
        },
      };
    },
  };
}

/**
 * Merkle keys over the graph's strongly connected components (Tarjan,
 * iterative): a component's key hashes its members' paths and blobs and the
 * keys of the components it imports; each member's key is the component's
 * plus its own path. Both static and dynamic edges count — a module's code can
 * run either.
 */
function merkleKeys(
  modules: ReadonlyMap<string, ModuleNode>,
): Map<string, string> {
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const compOf = new Map<string, number>();
  const comps: string[][] = [];
  let counter = 0;
  const depsOf = (p: string): string[] => {
    const n = modules.get(p)!;
    return [...n.staticDeps, ...n.dynamicDeps];
  };

  for (const start of [...modules.keys()].sort()) {
    if (index.has(start)) continue;
    const work: { node: string; next: number }[] = [{ node: start, next: 0 }];
    index.set(start, counter);
    low.set(start, counter);
    counter++;
    stack.push(start);
    onStack.add(start);
    while (work.length > 0) {
      const frame = work[work.length - 1]!;
      const deps = depsOf(frame.node);
      if (frame.next < deps.length) {
        const d = deps[frame.next++]!;
        if (!index.has(d)) {
          index.set(d, counter);
          low.set(d, counter);
          counter++;
          stack.push(d);
          onStack.add(d);
          work.push({ node: d, next: 0 });
        } else if (onStack.has(d)) {
          low.set(frame.node, Math.min(low.get(frame.node)!, index.get(d)!));
        }
        continue;
      }
      work.pop();
      if (work.length > 0) {
        const parent = work[work.length - 1]!.node;
        low.set(parent, Math.min(low.get(parent)!, low.get(frame.node)!));
      }
      if (low.get(frame.node) === index.get(frame.node)) {
        const comp: string[] = [];
        let w: string;
        do {
          w = stack.pop()!;
          onStack.delete(w);
          compOf.set(w, comps.length);
          comp.push(w);
        } while (w !== frame.node);
        comps.push(comp);
      }
    }
  }

  // Tarjan emits components in reverse topological order: every component a
  // component imports is already keyed when it is reached.
  const compKeys: string[] = [];
  const keys = new Map<string, string>();
  for (const [ci, comp] of comps.entries()) {
    const members = [...comp].sort();
    const parts: string[] = [];
    const external = new Set<string>();
    for (const m of members) {
      const n = modules.get(m)!;
      parts.push(m, n.blob, ...n.unresolved.map((u) => `?${u}`));
      for (const d of depsOf(m)) {
        const dc = compOf.get(d)!;
        if (dc !== ci) external.add(compKeys[dc]!);
      }
    }
    const compKey = recordKey("scc", ...parts, "->", ...[...external].sort());
    compKeys.push(compKey);
    for (const m of members) keys.set(m, recordKey(compKey, m));
  }
  return keys;
}
