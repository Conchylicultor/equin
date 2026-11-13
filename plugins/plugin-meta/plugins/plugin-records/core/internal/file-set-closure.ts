import type {
  RepoFiles,
  RepoSnapshot,
} from "@plugins/framework/plugins/tooling/core";
import {
  buildModuleGraph,
  NO_OUTSIDE_FILES,
  type BundledClosure,
  type ModuleGraphInput,
} from "./module-graph";
import { currentRecordStore } from "./store";

/** Decides, over the modules a closure can reach, which `import()` edges it follows. */
export type FollowDynamic = (reach: {
  modules: readonly string[];
  input: ModuleGraphInput;
}) => Promise<(module: string, spec: string) => boolean>;

/** The graph input every reader of `repo` shares — each part by identity, so they grow ONE graph. */
function sharedInput(
  repo: RepoFiles | RepoSnapshot,
  written: ReadonlyMap<string, string> | undefined,
): ModuleGraphInput {
  return {
    snapshot: repo,
    store: currentRecordStore(),
    readOutside: NO_OUTSIDE_FILES,
    ...(written === undefined ? {} : { written }),
  };
}

/** A module the runtime loads as code (not an asset a bundler query or loader names). */
const SCRIPT_MODULE = /\.(m?[jt]sx?|c[jt]s)$/;

/**
 * The repo script modules each of `modules` loads WITH it at runtime (its
 * static imports, `import type` and all-`type` binding lists erased — the
 * runtime's reading, through its own transpiler; an import used only in a type
 * position still loads), read off the same shared module graph as
 * {@link fileSetClosure}: each module's imports are a file record keyed by its
 * blob, so a pass after an edit reads and scans the edited modules alone. The
 * one source of a module's import facts — a reader asking which modules a file
 * loads never parses its imports itself.
 *
 * With `edges: "dynamic"`, its `import()`s of repo script
 * modules instead, in source order — what a registry of lazy loaders names.
 *
 * An import that resolves to no file of the set throws, naming the module.
 */
export async function fileSetImports(
  repo: RepoFiles | RepoSnapshot,
  modules: readonly string[],
  opts?: { edges?: "static" | "dynamic" },
): Promise<Map<string, string[]>> {
  const graph = await buildModuleGraph(sharedInput(repo, undefined), modules);
  const out = new Map<string, string[]>();
  for (const m of modules) {
    const node = graph.modules.get(m)!;
    if (node.unresolved.length > 0)
      throw new Error(
        `${m} imports ${node.unresolved.map((u) => JSON.stringify(u)).join(", ")}, which resolves to no file of the checkout.`,
      );
    const deps = opts?.edges === "dynamic" ? node.dynamicDeps : node.staticDeps;
    out.set(
      m,
      [...new Set(deps)].filter((d) => SCRIPT_MODULE.test(d)),
    );
  }
  return out;
}

/**
 * Every repo script module `entries` can load at runtime — static imports as
 * the runtime reads them (type-only erased, an import used only in a type
 * position kept: it still loads; `require()` included) and its `import()`s, since a
 * lazy load still runs on the importer's thread — each mapped to the module
 * that first reached it, breadth-first in sorted entry order (null for an
 * entry). Read off the same shared module graph as {@link fileSetImports}: a
 * pass after an edit scans the edited modules alone, and no reader of what a
 * process loads parses or resolves imports itself.
 *
 * With `dynamic: false`, only what loads WITH the entries — static imports
 * (and `require()`), no `import()`: what their module-load evaluates.
 *
 * An import of a reached module that resolves to no file of the set throws,
 * naming the module — skipping it would pass whatever it loads.
 */
export async function fileSetRuntimeReach(
  repo: RepoFiles | RepoSnapshot,
  entries: readonly string[],
  opts?: { dynamic?: boolean },
): Promise<Map<string, string | null>> {
  const dynamic = opts?.dynamic ?? true;
  const sorted = [...new Set(entries)].sort();
  const graph = await buildModuleGraph(sharedInput(repo, undefined), sorted);
  const parent = new Map<string, string | null>();
  for (const e of sorted) parent.set(e, null);
  for (let i = 0, queue = [...sorted]; i < queue.length; i++) {
    const m = queue[i]!;
    const node = graph.modules.get(m)!;
    if (node.unresolved.length > 0)
      throw new Error(
        `${m} imports ${node.unresolved.map((u) => JSON.stringify(u)).join(", ")}, which resolves to no file of the checkout.`,
      );
    const deps = dynamic
      ? [...node.staticDeps, ...node.dynamicDeps]
      : node.staticDeps;
    for (const d of deps) {
      if (parent.has(d) || !SCRIPT_MODULE.test(d)) continue;
      parent.set(d, m);
      queue.push(d);
    }
  }
  return parent;
}

/**
 * The bundler's closure of `entries` over a file set (dynamic imports cut,
 * unused TypeScript imports dropped — what `importClosures` measures with a
 * whole `Bun.build`, proven equal by `scripts/closure-equivalence.ts`), read
 * off the module graph: every module's imports are a file record keyed by its
 * blob, so after an edit only the edited modules are read and scanned.
 *
 * The graph input it builds is the one every reader of the set shares (the
 * set, the installed store, no file outside the set — each by identity), so
 * the checks of one pass and codegen grow ONE graph per set. `input` is
 * returned for a reader that keeps per-module facts beside it
 * (`scanFilesCached` over the closure's modules).
 *
 * Every module is a member of the set: an import that resolves to no file of
 * it throws, naming the module — a gitignored module would otherwise drop out
 * of the closure, and with it whatever it loads.
 */
export async function fileSetClosure(
  repo: RepoFiles | RepoSnapshot,
  entries: readonly string[],
  opts?: {
    /** Files whose content is not the set's (a build's own outputs), repo-relative → content. */
    written?: ReadonlyMap<string, string>;
    /**
     * Which `import()` edges to follow (none by default: the static graph).
     * Handed every module the entries can load at all (static and dynamic
     * edges) and the graph input, so it can read what it needs of each — its
     * file records — before it answers per edge.
     */
    followDynamic?: FollowDynamic;
  },
): Promise<{ closure: BundledClosure; input: ModuleGraphInput }> {
  const input = sharedInput(repo, opts?.written);
  const graph = await buildModuleGraph(input, entries);
  const followDynamic =
    opts?.followDynamic === undefined
      ? undefined
      : await opts.followDynamic({ modules: [...graph.modules.keys()], input });
  const closure = graph.bundledClosure(
    entries,
    followDynamic === undefined ? undefined : { followDynamic },
  );
  for (const m of closure.modules) {
    const unresolved = graph.modules.get(m)!.unresolved;
    if (unresolved.length > 0)
      throw new Error(
        `${m} imports ${unresolved.map((u) => JSON.stringify(u)).join(", ")}, which resolves to no file of the checkout: a closure is measured over the file set.`,
      );
  }
  return { closure, input };
}
