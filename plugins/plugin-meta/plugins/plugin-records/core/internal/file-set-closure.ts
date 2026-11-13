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
  const input: ModuleGraphInput = {
    snapshot: repo,
    store: currentRecordStore(),
    readOutside: NO_OUTSIDE_FILES,
    ...(opts?.written === undefined ? {} : { written: opts.written }),
  };
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
