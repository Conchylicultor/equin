import type {
  RepoFiles,
  RepoSnapshot,
} from "@plugins/framework/plugins/tooling/core";
import {
  buildModuleGraph,
  currentRecordStore,
  NO_OUTSIDE_FILES,
  scanFilesCached,
} from "@plugins/plugin-meta/plugins/plugin-records/core";
import {
  BINDINGS_SCAN,
  type BoundNames,
  type ReexportFacts,
} from "./bindings.scan";

// Apart from plugin-records' core so its scan's parser (parse-utils' core)
// stays out of the key of every record producer importing that barrel (the
// barrel evaluator's, held by `evaluate:evaluator-key-width`).

/** A module the runtime loads as code (not an asset a bundler query or loader names). */
const SCRIPT_MODULE = /\.(m?[jt]sx?|c[jt]s)$/;

/** One module's resolved imports with the names each binds: {@link fileSetBindings}' answer. */
export interface ModuleBindings {
  /**
   * Every repo module it imports — the module graph's edges, static and
   * dynamic — with the names the edge asks: a static edge the names its
   * statements bind, `"all"` for an `import()` or a `require()`. An edge whose
   * statements bind only types asks `[]` (the runtime still loads it).
   */
  imports: { target: string; names: BoundNames }[];
  /** A pure re-export module's `export … from`s of repo modules, resolved; null for any other module. */
  reexports: { target: string; exports: ReexportFacts["exports"] }[] | null;
  /** The packages (npm, and runtime builtins) it imports by name — the graph's `packages`. */
  packages: readonly string[];
}

/**
 * Each of `modules`' imports, resolved by the module graph and annotated with
 * the names each binds (a per-blob {@link BINDINGS_SCAN} record joined onto
 * the graph's edges by specifier) — what a reader walking a closure BY NAME
 * through barrels needs, without parsing or resolving an import itself. The
 * graph decides which edges exist (an `import type`, an all-`type` binding
 * list, an `import()` in a type position: none); the scan only narrows the
 * names they ask.
 *
 * An import of a module that resolves to no file of the set throws, naming
 * the module.
 */
export async function fileSetBindings(
  repo: RepoFiles | RepoSnapshot,
  modules: readonly string[],
): Promise<Map<string, ModuleBindings>> {
  // The input every reader of `repo` shares, each part by identity: one graph per set.
  const input = {
    snapshot: repo,
    store: currentRecordStore(),
    readOutside: NO_OUTSIDE_FILES,
  };
  const graph = await buildModuleGraph(input, modules);
  const scanned = modules.filter((m) => SCRIPT_MODULE.test(m));
  const facts = await scanFilesCached(input, scanned, BINDINGS_SCAN);
  const factsOf = new Map(scanned.map((m, i) => [m, facts[i]!]));
  const out = new Map<string, ModuleBindings>();
  for (const m of modules) {
    const node = graph.modules.get(m)!;
    if (node.unresolved.length > 0)
      throw new Error(
        `${m} imports ${node.unresolved.map((u) => JSON.stringify(u)).join(", ")}, which resolves to no file of the checkout.`,
      );
    const f = factsOf.get(m);
    const targetOf = new Map(node.staticImports.map((i) => [i.spec, i.target]));
    out.set(m, {
      imports: [
        ...node.staticImports.map(({ spec, target }) => ({
          target,
          names: f?.names[spec] ?? ("all" as const),
        })),
        ...node.dynamicDeps.map((target) => ({
          target,
          names: "all" as const,
        })),
      ],
      reexports:
        f?.reexports == null
          ? null
          : f.reexports.flatMap(({ spec, exports }) => {
              const target = targetOf.get(spec);
              return target === undefined ? [] : [{ target, exports }];
            }),
      packages: node.packages,
    });
  }
  return out;
}
