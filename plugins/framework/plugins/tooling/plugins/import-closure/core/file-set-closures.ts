import type { RepoFiles } from "@plugins/framework/plugins/tooling/core";
import {
  fileSetClosure,
  scanFilesCached,
} from "@plugins/plugin-meta/plugins/plugin-records/core";
import type { DynamicImportPolicy, UnionImportClosure } from "./import-closure";

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
 *     `scanCommandRuns`).
 *
 * An import that resolves to no file of the set throws (`fileSetClosure`).
 */
export async function fileSetImportClosures(
  repo: RepoFiles,
  entries: readonly string[],
  opts: { dynamicImports: DynamicImportPolicy },
): Promise<UnionImportClosure> {
  const { closure } = await fileSetClosure(
    repo,
    entries,
    opts.dynamicImports === "cut"
      ? undefined
      : {
          followDynamic: async ({ modules, input }) => {
            const { COMMAND_RUNS_SCAN } = await import("./command-runs.scan");
            const scans = await scanFilesCached(
              input,
              modules,
              COMMAND_RUNS_SCAN,
            );
            const cut = new Map<string, Set<string>>();
            for (const [i, scan] of scans.entries()) {
              const runs = Object.keys(scan.runs).filter(
                (spec) => !scan.other.includes(spec),
              );
              if (runs.length > 0) cut.set(modules[i]!, new Set(runs));
            }
            return (module, spec) => cut.get(module)?.has(spec) !== true;
          },
        },
  );
  return closure;
}
