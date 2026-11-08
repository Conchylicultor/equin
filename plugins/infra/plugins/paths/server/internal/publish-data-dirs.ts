import { loadCollectedDir } from "@plugins/framework/plugins/tooling/plugins/collected-dir/core";
import { getDataDirs, isDataDir } from "../../core/internal/data-dir";
import type { DataDir } from "../../core/internal/data-dir";
import {
  declaredSets,
  writeDataDirsManifestSync,
} from "../../core/internal/data-dirs-manifest";
import { runtimeNamespace } from "@plugins/infra/plugins/runtime-identity/core";
import { isRelease } from "../../core/internal/paths";

/**
 * Publish what THIS namespace declares under the shared data root, so an audit
 * running in another checkout can tell one of this branch's directories from an
 * orphan. See `core/internal/data-dirs-manifest.ts` for why that is needed at
 * all.
 *
 * The backend is the writer because it is the process that actually CREATES
 * these directories: a namespace that can write to the root is exactly a
 * namespace whose backend has run. It is deliberately not a `defineWarmup` —
 * a warm-up is documented as "an OPTIMIZATION, never a correctness dependency"
 * whose throw is logged and skipped, and a namespace that silently fails to
 * publish has its live directories reported as another checkout's orphans.
 *
 * Loading the collected dir EVALUATES each owner's `data-dirs/index.ts`, which
 * is what populates the registry — the same call, with the same arguments, that
 * `paths:no-undeclared-data-dirs` makes. The registry alone is not enough: it
 * holds only the declarations whose module some running code happened to import,
 * so a namespace would under-publish exactly the directories nothing had touched
 * yet.
 */
export async function publishDataDirsManifest(): Promise<void> {
  // A release runs against its own data root, and its "namespace" is not a
  // worktree at all. It has no siblings to attribute anything to.
  if (isRelease()) return;

  // Read at the call, never at module load: a CLI process that regenerates the
  // registry loads this module first (`cli:codegen-manifests-not-frozen`).
  const { dataDirsEntries } = await import("../../core/data-dirs.generated");
  await loadCollectedDir<DataDir>(dataDirsEntries, {
    isItem: isDataDir,
    dedupeKey: (d) => `${d.spec.kind}/${d.spec.name}`,
    label: "data-dir",
  });
  writeDataDirsManifestSync(runtimeNamespace(), declaredSets(getDataDirs()));
}
