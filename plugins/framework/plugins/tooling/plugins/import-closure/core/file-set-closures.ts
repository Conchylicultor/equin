import type { RepoFiles } from "@plugins/framework/plugins/tooling/core";
import {
  buildModuleGraph,
  fileSetClosure,
  scanFilesCached,
} from "@plugins/plugin-meta/plugins/plugin-records/core";
import type {
  CommandRunEdge,
  DynamicImportPolicy,
  UnionImportClosure,
} from "./import-closure";

/** What {@link fileSetImportClosures} answers. */
export interface FileSetImportClosure extends UnionImportClosure {
  /**
   * The command `run` thunks cut under `"follow-except-command-runs"`, each
   * resolved to the module it imports, in path order of their declarations
   * ({@link CommandRunEdge}) — `importClosure`'s `commandRuns`, over every
   * entry. Empty under `"cut"`, which cuts every dynamic edge unclassified.
   */
  commandRuns: CommandRunEdge[];
}

/**
 * {@link importClosures} over a file set, from the plugin-records module
 * graph instead of a `Bun.build`: every module's imports are a file record
 * keyed by its blob, and so is which of its `import()` edges are command
 * `run` thunks (`command-runs.scan.ts`) — so a check pass after an edit reads
 * and scans the edited modules alone, where a build parses the whole closure
 * on every pass. The same answer: modules, edges (`children`), the chain to a
 * module from the first entry reaching it, and the npm specifiers each module
 * keeps statically (`external`, runtime builtins included — a bundle's
 * resolver never sees those).
 *
 *   - `"cut"` — the static graph (the module graph's bundler view);
 *   - `"follow-except-command-runs"` — every literal `import()` of a repo
 *     module is followed too, except a command declaration's `run` thunk
 *     whose specifier no other `import()` of the same file names (see
 *     `scanCommandRuns`); those are reported as `commandRuns`.
 *
 * What a graph cannot answer is tree-shaking (`importClosure`'s `live`): a
 * reader of it records the bundle's answer with `closureRecord`'s `bundled`,
 * keyed on this closure.
 *
 * An import that resolves to no file of the set throws (`fileSetClosure`).
 */
export async function fileSetImportClosures(
  repo: RepoFiles,
  entries: readonly string[],
  opts: { dynamicImports: DynamicImportPolicy },
): Promise<FileSetImportClosure> {
  // declaration module → the `run` specifiers it cuts → the verbs each runs.
  const cut = new Map<string, Map<string, readonly string[]>>();
  const { closure, input } = await fileSetClosure(
    repo,
    entries,
    opts.dynamicImports === "cut"
      ? undefined
      : {
          followDynamic: async ({ modules, input }) => {
            // Only a module with an `import()` of a repo module can hold a
            // run thunk: the others (most of a closure) need no scan.
            const graph = await buildModuleGraph(input, modules);
            const dynamic = modules.filter(
              (m) => graph.modules.get(m)!.dynamicImports.length > 0,
            );
            const { COMMAND_RUNS_SCAN } = await import("./command-runs.scan");
            const scans = await scanFilesCached(
              input,
              dynamic,
              COMMAND_RUNS_SCAN,
            );
            for (const [i, scan] of scans.entries()) {
              const runs = Object.entries(scan.runs).filter(
                ([spec]) => !scan.other.includes(spec),
              );
              if (runs.length > 0) cut.set(dynamic[i]!, new Map(runs));
            }
            return (module, spec) => cut.get(module)?.has(spec) !== true;
          },
        },
  );
  const commandRuns: CommandRunEdge[] = [];
  const declarations = [...closure.modules].filter((m) => cut.has(m)).sort();
  if (declarations.length > 0) {
    const graph = await buildModuleGraph(input, declarations);
    for (const declaration of declarations) {
      const runs = cut.get(declaration)!;
      const seen = new Set<string>();
      for (const { spec, target } of graph.modules.get(declaration)!
        .dynamicImports) {
        const commands = runs.get(spec);
        if (commands === undefined || seen.has(spec)) continue;
        seen.add(spec);
        commandRuns.push({ commands, declaration, target });
      }
    }
  }
  return { ...closure, commandRuns };
}
