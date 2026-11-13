import { sharedWork } from "@plugins/packages/plugins/shared-work/core";
import type {
  RepoFiles,
  RepoSnapshot,
} from "@plugins/framework/plugins/tooling/core";
import { groupedByOwner, readGrouped } from "./grouped";
import { gitBlobId, recordKey } from "./keys";
import { npmCodeKey } from "./npm-identity";
import type { RecordStore } from "./store";
import {
  isRepoSpecifier,
  specifierCandidates,
} from "@plugins/plugin-meta/plugins/plugin-records/plugins/specifier/core";
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
/**
 * The npm package a bare specifier loads: `@scope/name` or `name`, whatever
 * subpath follows (`@typescript-eslint/parser/dist/x` → `@typescript-eslint/parser`).
 */
function packageOf(spec: string): string {
  const path = spec.split("?")[0]!;
  const parts = path.split("/");
  return path.startsWith("@") && parts.length > 1
    ? `${parts[0]}/${parts[1]}`
    : parts[0]!;
}

export interface ModuleNode {
  /** Repo-relative path. */
  path: string;
  /** Its content id: the snapshot's blob, the overlay's, or one hashed from disk. */
  blob: string;
  /** The repo modules it loads with it (static imports), repo-relative. */
  staticDeps: string[];
  /**
   * Each static import of a repo module, as written and as resolved — what a
   * reader that knows something per specifier (the names a statement binds)
   * joins on, so it never resolves a specifier itself.
   */
  staticImports: { spec: string; target: string }[];
  /** The subset of {@link staticDeps} a bundler keeps (see `ImportSpec.unused`). */
  bundledDeps: string[];
  /** The repo modules it can load later (`import()`, `require()`). */
  dynamicDeps: string[];
  /**
   * Each `import("…")` of a repo module, as written and as resolved — what a
   * reader deciding per edge which dynamic imports to follow reads
   * ({@link ModuleGraph.bundledClosure}'s `followDynamic`).
   */
  dynamicImports: { spec: string; target: string }[];
  /** Internal specifiers that resolve to no file — part of its key, so a file appearing moves it. */
  unresolved: string[];
  /**
   * The npm packages (and runtime builtins: `node:fs`, `bun`) it imports by
   * name — statically or not, used or not: every package its code can load.
   * A function of its blob, so its Merkle key already covers the list.
   */
  packages: string[];
  /**
   * The bare specifiers (npm and runtime builtins, as written: `typescript`,
   * `typescript/lib/tsserverlibrary`, `node:fs`) it imports statically and a
   * bundler keeps — what `Bun.build` externalizes for it with dynamic imports
   * cut. Derived from its file facts, so its Merkle key covers it.
   */
  bundledExternals: string[];
  /** The bare specifiers it imports with `import("…")`, as written. */
  dynamicExternals: string[];
}

export interface ModuleGraph {
  readonly modules: ReadonlyMap<string, ModuleNode>;
  /** The Merkle key of a module of the graph. */
  keyOf(path: string): string;
  /**
   * Every bare specifier's package (npm or builtin) a module of the graph
   * imports, sorted: the npm code the entries' closure can load (static and
   * dynamic edges, the reach their keys cover), before the packages' own
   * dependencies — `npmCodeKey` closes it over the lockfile.
   */
  readonly packages: readonly string[];
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
  bundledClosure(
    entries: readonly string[],
    opts?: {
      /**
       * Whether to follow `module`'s `import(spec)` (its
       * {@link ModuleNode.dynamicImports}) as an edge of the closure — none
       * by default, as a bundler measuring the static graph cuts them all.
       */
      followDynamic?: (module: string, spec: string) => boolean;
    },
  ): BundledClosure;
}

export interface BundledClosure {
  modules: Set<string>;
  /**
   * Every bare specifier a module of the closure imports statically and keeps
   * ({@link ModuleNode.bundledExternals}) — and, when the closure follows
   * dynamic imports, every one it imports with `import("…")` — with its
   * importers in the order the closure reached them: `importClosures`'
   * `external`, builtins included.
   */
  external: Map<string, string[]>;
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
  /**
   * A file outside the snapshot (gitignored): its content, or null when
   * absent. Calls sharing this function (by identity) share one graph over
   * the same set: a reader with no file outside the set passes
   * {@link NO_OUTSIDE_FILES}, not a fresh `async () => null`, so they do; one
   * reading the checkout passes `outsideFilesAt(root)`.
   */
  readOutside: OutsideFiles;
}

/**
 * A reader of the files outside a snapshot. Asynchronous: the graph is grown
 * on whatever thread asks for it, a backend's included.
 */
export type OutsideFiles = (rel: string) => Promise<string | null>;

/** No file outside the set exists: an import of a gitignored module resolves to nothing. */
export const NO_OUTSIDE_FILES: OutsideFiles = async () => null;

/**
 * The graph reachable from `entries` (repo-relative), with Merkle keys. Reads
 * a module's source only when its file facts are not in the store.
 *
 * ONE GRAPH PER SET. Every call over the same input (snapshot, store, written
 * overlay and outside reader, each by identity) grows one shared graph: it
 * walks only the modules no earlier call reached, and keys only those. A
 * build asks for ~9 closures of one snapshot (facet identities, portability,
 * each browser host, the drizzle verdict, the host snapshot), which overlap
 * heavily: walked one by one they visited ~31k modules for ~11k distinct
 * ones. A module's facts, resolution and key are functions of the set alone,
 * so who asked first cannot change them; and an earlier module's closure
 * cannot contain a later one (its walk was complete), so its key never moves
 * as the graph grows. Each call gets a view of exactly its entries' closure.
 */
export async function buildModuleGraph(
  input: ModuleGraphInput,
  entries: readonly string[],
): Promise<ModuleGraph> {
  const state = sharedState(input);
  // The graph is shared by every caller over this set, so what growing it
  // reads is no caller's own (`sharedWork`).
  const grown = state.growing.then(() =>
    sharedWork("plugin records", async () =>
      growGraph(state, input, entries, await fileFactsIdentity(input)),
    ),
  );
  // The next growth waits for this one to SETTLE: a failed walk is rolled back
  // (`growGraph`) and its error is this caller's, delivered by the await below.
  state.growing = Promise.allSettled([grown]).then(() => undefined);
  await grown;
  return viewOf(state, entries);
}

const factsIdentities = new WeakMap<object, Promise<string>>();

/**
 * The file facts' identity over `input`'s set: the Merkle key of the scan's own
 * closure, from a graph that reads no record (its facts would need this very
 * identity) — a handful of files, scanned directly.
 */
function fileFactsIdentity(input: ModuleGraphInput): Promise<string> {
  let id = factsIdentities.get(input.snapshot);
  if (!id) {
    const own = newState();
    id = sharedWork("plugin records", () =>
      growGraph(own, input, [SCAN_MODULE], null),
    ).then(async () => {
      const view = viewOf(own, [SCAN_MODULE]);
      return recordKey(
        "file-facts",
        view.keyOf(SCAN_MODULE),
        input.store.environment,
        await npmCodeKey(input.snapshot, view.packages),
      );
    });
    factsIdentities.set(input.snapshot, id);
  }
  return id;
}

/** One growing graph over one input. */
interface GraphState {
  modules: Map<string, ModuleNode>;
  /** Each module's Merkle key: its component's key plus its own path. */
  keys: Map<string, string>;
  /** Each module's component key: what an importer's key folds in. */
  compKeys: Map<string, string>;
  /** Contents read outside the set, by path (null: absent). */
  outsideContent: Map<string, Promise<string | null>>;
  /** A plain file set's members, read once: its blob id and its scan share it. */
  memberContent: Map<string, Promise<string | null>>;
  /** Growth is one call at a time: a call's walk sees every earlier call's modules. */
  growing: Promise<void>;
}

function newState(): GraphState {
  return {
    modules: new Map(),
    keys: new Map(),
    compKeys: new Map(),
    outsideContent: new Map(),
    memberContent: new Map(),
    growing: Promise.resolve(),
  };
}

// snapshot → store → readOutside → written overlay (or NO_WRITTEN) → state;
// weak at every level, so a graph lives exactly as long as its inputs.
const NO_WRITTEN: object = {};
const states = new WeakMap<
  object,
  WeakMap<object, WeakMap<object, WeakMap<object, GraphState>>>
>();

function sharedState(input: ModuleGraphInput): GraphState {
  const level = <K extends object, V>(
    m: WeakMap<K, V>,
    k: K,
    make: () => V,
  ): V => {
    let v = m.get(k);
    if (v === undefined) m.set(k, (v = make()));
    return v;
  };
  const byStore = level(states, input.snapshot, () => new WeakMap());
  const byOutside = level(byStore, input.store, () => new WeakMap());
  const byWritten = level(byOutside, input.readOutside, () => new WeakMap());
  return level(byWritten, input.written ?? NO_WRITTEN, newState);
}

/**
 * Grow `state` to cover `entries`' closures; `factsId` keys its file records,
 * or null to read and write none.
 */
async function growGraph(
  state: GraphState,
  input: ModuleGraphInput,
  entries: readonly string[],
  factsId: string | null,
): Promise<void> {
  const { snapshot, store } = input;
  const { modules, outsideContent, memberContent } = state;
  const contentOutside = (rel: string): Promise<string | null> => {
    let c = outsideContent.get(rel);
    if (c === undefined) {
      c = input.readOutside(rel);
      outsideContent.set(rel, c);
    }
    return c;
  };
  const exists = async (rel: string): Promise<boolean> =>
    input.written?.has(rel) ||
    snapshot.has(rel) ||
    (await contentOutside(rel)) !== null;
  const hasBlobs =
    typeof (snapshot as Partial<RepoSnapshot>).blobOf === "function";
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
    const c = await contentOutside(rel);
    if (c === null)
      throw new Error(`[plugin-records] module ${rel} does not exist`);
    return gitBlobId(c);
  };
  const resolveFrom = async (
    fromRel: string,
    spec: string,
  ): Promise<string | null> => {
    // The one resolver's candidates (`plugin-records/specifier`); a bundler
    // query (`./clip.mp4?inline`, `?raw`) names the file it loads.
    const candidates = specifierCandidates(fromRel, spec);
    if (candidates === null) return null;
    // The path the specifier names, before an extension or index is tried.
    const base = candidates[0]!;
    // The file set first: a probe of the disk is only for a gitignored
    // module (a generated file a barrel imports), never the common case.
    for (const c of candidates)
      if (input.written?.has(c) || snapshot.has(c)) {
        // Bun resolves a directory through its package.json (`main`,
        // `exports`) before `index.*`; the graph does not read manifests, so
        // it refuses rather than answer a module Bun would not load.
        if (
          c.startsWith(`${base}/index.`) &&
          (input.written?.has(`${base}/package.json`) ||
            snapshot.has(`${base}/package.json`))
        )
          throw new Error(
            `[plugin-records] ${fromRel} imports the directory ${base}, which has a package.json: Bun resolves it through the manifest, which the module graph does not read — import a file of it instead`,
          );
        return c;
      }
    // One at a time, stopping at the first: each probe reads the file.
    for (const c of candidates)
      if ((await contentOutside(c)) !== null) return c;
    return null;
  };

  for (const e of entries)
    if (!modules.has(e) && !(await exists(e)))
      throw new Error(`[plugin-records] entry module ${e} does not exist`);
  // Only what no earlier call reached is walked: an existing module's deps are
  // all in the graph already (its walk was complete).
  let level = [...new Set(entries)].filter((e) => !modules.has(e));
  const queued = new Set(level);
  const added: string[] = [];
  try {
    await walkLevels();
  } catch (err) {
    // A walk that throws leaves the graph as it was: no module without a key,
    // none whose deps were never walked.
    for (const m of added) modules.delete(m);
    throw err;
  }
  for (const [m, comp] of merkleKeys(modules, added, state.compKeys)) {
    state.compKeys.set(m, comp);
    state.keys.set(m, recordKey(comp, m));
  }

  async function walkLevels(): Promise<void> {
    while (level.length > 0) {
      const blobs = await Promise.all(level.map(blobOf));
      const factKey = (blob: string): string => recordKey(factsId!, blob);
      // Read a plugin at a time: a level's modules of one plugin are one
      // group record (the walk is deterministic for a snapshot and its
      // entries, so a no-change build finds the same groups).
      const scanned =
        factsId === null
          ? []
          : level.flatMap((p, i) => (SCANNED.test(p) ? [i] : []));
      const hits = await readGrouped(
        store,
        "file",
        groupedByOwner(
          scanned.map((i) => level[i]!),
          scanned.map((i) => factKey(blobs[i]!)),
        ),
      );
      const fresh: [string, string][] = [];
      const next: string[] = [];
      const nodes = await Promise.all(
        level.map(async (path, i): Promise<ModuleNode> => {
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
                  : await contentOutside(path));
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
            staticImports: [],
            bundledDeps: [],
            dynamicDeps: [],
            dynamicImports: [],
            unresolved: [],
            packages: [],
            bundledExternals: [],
            dynamicExternals: [],
          };
          for (const imp of facts.imports) {
            if (!isRepoSpecifier(imp.spec)) {
              const pkg = packageOf(imp.spec);
              if (!node.packages.includes(pkg)) node.packages.push(pkg);
              const list = imp.dynamic
                ? node.dynamicExternals
                : imp.unused
                  ? null
                  : node.bundledExternals;
              if (list !== null && !list.includes(imp.spec))
                list.push(imp.spec);
              continue;
            }
            const target = await resolveFrom(path, imp.spec);
            if (target === null) {
              node.unresolved.push(imp.spec);
              continue;
            }
            if (imp.dynamic) {
              node.dynamicDeps.push(target);
              node.dynamicImports.push({ spec: imp.spec, target });
            } else {
              node.staticDeps.push(target);
              node.staticImports.push({ spec: imp.spec, target });
              if (!imp.unused) node.bundledDeps.push(target);
            }
          }
          return node;
        }),
      );
      if (factsId !== null && fresh.length > 0) store.putMany("file", fresh);
      for (const node of nodes) {
        modules.set(node.path, node);
        added.push(node.path);
        for (const d of [...node.staticDeps, ...node.dynamicDeps]) {
          if (modules.has(d) || queued.has(d)) continue;
          queued.add(d);
          next.push(d);
        }
      }
      level = next;
    }
  }
}

/** The graph as one call sees it: exactly the closure of its entries. */
function viewOf(state: GraphState, entries: readonly string[]): ModuleGraph {
  const all = state.modules;
  // Static and dynamic edges: the reach a module's key covers. Breadth-first
  // from the entries in order, each node's edges in order — the order a single
  // walk inserted them in, so a reader iterating `modules` (the first
  // unresolved import named) sees the same order whoever grew the graph.
  const reach = new Map<string, ModuleNode>();
  const queue = [...new Set(entries)];
  for (const p of queue) {
    const n = all.get(p);
    if (!n) throw new Error(`[plugin-records] ${p} is not in the module graph`);
    reach.set(p, n);
  }
  for (let i = 0; i < queue.length; i++) {
    const n = reach.get(queue[i]!)!;
    for (const d of [...n.staticDeps, ...n.dynamicDeps]) {
      if (reach.has(d)) continue;
      const dn = all.get(d);
      if (!dn)
        throw new Error(`[plugin-records] ${d} is not in the module graph`);
      reach.set(d, dn);
      queue.push(d);
    }
  }
  const modules: ReadonlyMap<string, ModuleNode> = reach;
  const keys = state.keys;
  const packages = new Set<string>();
  for (const n of reach.values()) for (const p of n.packages) packages.add(p);
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
    packages: [...packages].sort(),
    keyOf(path) {
      const k = modules.has(path) ? keys.get(path) : undefined;
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
    bundledClosure(entries, opts) {
      const follow = opts?.followDynamic;
      // A module's edges: its kept static imports, plus the dynamic ones the
      // caller follows — sorted, once per module.
      const edges = new Map<string, string[]>();
      const childrenOf = (m: string): string[] => {
        let c = edges.get(m);
        if (c === undefined) {
          const n = modules.get(m);
          if (!n)
            throw new Error(`[plugin-records] ${m} is not in the module graph`);
          const all = new Set(n.bundledDeps);
          if (follow !== undefined)
            for (const d of n.dynamicImports)
              if (follow(m, d.spec)) all.add(d.target);
          edges.set(m, (c = [...all].sort()));
        }
        return c;
      };
      // BFS from each entry in order: the first entry reaching a module, and
      // the shortest chain from it, as the bundler's record answers.
      const parent = new Map<string, string | null>();
      for (const e of entries) {
        if (parent.has(e)) continue;
        parent.set(e, null);
        const queue = [e];
        for (const p of queue) {
          for (const d of childrenOf(p)) {
            if (parent.has(d)) continue;
            parent.set(d, p);
            queue.push(d);
          }
        }
      }
      const members = new Set(parent.keys());
      const external = new Map<string, string[]>();
      for (const m of members)
        for (const spec of follow === undefined
          ? modules.get(m)!.bundledExternals
          : [
              ...modules.get(m)!.bundledExternals,
              ...modules.get(m)!.dynamicExternals,
            ]) {
          const importers = external.get(spec);
          if (importers === undefined) external.set(spec, [m]);
          else importers.push(m);
        }
      const assertIn = (m: string): void => {
        if (!members.has(m))
          throw new Error(`[plugin-records] ${m} is not in the closure`);
      };
      return {
        modules: members,
        external,
        children(m) {
          assertIn(m);
          return [...childrenOf(m)];
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
  added: readonly string[],
  /** The component key of every module keyed before: never revisited. */
  knownComp: ReadonlyMap<string, string>,
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
  // A module keyed before is a leaf here: its component is closed (no new
  // module is in its closure), so it cannot share a cycle with one.
  const newDepsOf = (p: string): string[] =>
    depsOf(p).filter((d) => !knownComp.has(d));

  for (const start of [...added].sort()) {
    if (index.has(start)) continue;
    const work: { node: string; next: number }[] = [{ node: start, next: 0 }];
    index.set(start, counter);
    low.set(start, counter);
    counter++;
    stack.push(start);
    onStack.add(start);
    while (work.length > 0) {
      const frame = work[work.length - 1]!;
      const deps = newDepsOf(frame.node);
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
  /** Each new module's component key. */
  const keys = new Map<string, string>();
  for (const [ci, comp] of comps.entries()) {
    const members = [...comp].sort();
    const parts: string[] = [];
    const external = new Set<string>();
    for (const m of members) {
      const n = modules.get(m)!;
      parts.push(m, n.blob, ...n.unresolved.map((u) => `?${u}`));
      for (const d of depsOf(m)) {
        const known = knownComp.get(d);
        if (known !== undefined) external.add(known);
        else {
          const dc = compOf.get(d)!;
          if (dc !== ci) external.add(compKeys[dc]!);
        }
      }
    }
    const compKey = recordKey("scc", ...parts, "->", ...[...external].sort());
    compKeys.push(compKey);
    for (const m of members) keys.set(m, compKey);
  }
  return keys;
}
