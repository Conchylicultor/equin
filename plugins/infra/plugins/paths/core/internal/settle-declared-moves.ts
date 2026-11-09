import { loadCollectedDir } from "@plugins/framework/plugins/tooling/plugins/collected-dir/core";
import { getDataDirs, isDataDir, settleDataDirMoves } from "./data-dir";
import type { DataDir } from "./data-dir";

/**
 * Settle the moves of EVERY directory this checkout declares — what a process's
 * entry point awaits before it reads a path (a backend's `serve`, an `exec`
 * boot, a check that reads every declared dir). See `settleDataDirMoves`.
 *
 * Loading the collected dir evaluates each owner's `data-dirs/index.ts`, which
 * is what populates the registry: the registry alone holds only the
 * declarations some running code happened to import, and a move nobody had
 * imported yet would go unsettled — then throw on its first read.
 */
export async function settleDeclaredDataDirMoves(opts: {
  perform: boolean;
}): Promise<void> {
  // Read at the call, never at module load: a CLI process that regenerates the
  // registry loads this module first (`cli:codegen-manifests-not-frozen`).
  const { dataDirsEntries } = await import("../data-dirs.generated");
  await loadCollectedDir<DataDir>(dataDirsEntries, {
    isItem: isDataDir,
    dedupeKey: (d) => `${d.spec.kind}/${d.spec.name}`,
    label: "data-dir",
  });
  await settleDataDirMoves(getDataDirs().values(), opts);
}
