import {
  isOwnInput,
  sharedWork,
} from "@plugins/packages/plugins/shared-work/core";
import type TS from "typescript";
import type { CheckContext } from "@plugins/framework/plugins/tooling/core";
import {
  createSourceAnalysis,
  readRepoCompilerOptions,
  type SourceAnalysis,
} from "@plugins/framework/plugins/tooling/plugins/checks/plugins/source-analysis/core";
import { parsedTsSource } from "./source-work";

// A check's handle on the shared source analysis
// (`checks/plugins/source-analysis`): the repo project's compiler options,
// the run's file set, and the run-shared parse — so checks resolve imports,
// follow barrels and collect a declaration's uses from the syntax tree, never
// from regexes over masked text. One analysis per file set: every check of a
// pass shares one (its parses and resolutions), and an input-keyed check — whose
// `ctx.repo()` records its reads — gets its own, so each read lands in its
// read-set.

const byRepo = new WeakMap<object, Promise<SourceAnalysis>>();

let tsPromise: Promise<typeof TS> | undefined;
function loadTs(): Promise<typeof TS> {
  return (tsPromise ??= import("typescript").then((m) => m.default));
}

/** The run's source analysis (see `checks/CLAUDE.md` § "Reading code"). */
export async function sourceAnalysis(
  ctx: Pick<CheckContext, "repo">,
): Promise<SourceAnalysis> {
  const repo = await ctx.repo();
  let pending = byRepo.get(repo);
  if (pending === undefined) {
    // Over the run's set the analysis is shared by every check asking: a file
    // it reads is read once for all of them, so the read is no check's own.
    // Over one check's own (recording) set it serves that check alone, and
    // its reads are that check's.
    const files = isOwnInput(repo)
      ? repo
      : {
          has: (rel: string) => repo.has(rel),
          read: (rel: string) =>
            sharedWork("source analysis", () => repo.read(rel)),
        };
    pending = (async () => {
      const ts = await loadTs();
      return createSourceAnalysis({
        ts,
        files,
        parse: (source) => parsedTsSource(ts, source),
        compilerOptions: await readRepoCompilerOptions(ts, files),
      });
    })();
    byRepo.set(repo, pending);
  }
  return pending;
}
