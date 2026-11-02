import { existsSync, readFileSync } from "fs";
import { type AppPath } from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import { relative } from "path";
import {
  preBarrelManifests,
  type PreBarrelManifest,
} from "./pre-barrel-manifests";
import { formatGenerated } from "./write-generated";

/**
 * Runtime freeze-point guard for the pre-barrel manifest invariant.
 *
 * Installed (via `setPreBarrelImportGuard`) right after the pre-barrel manifests
 * are written and BEFORE `generatePluginDocs`, so it fires once at the first
 * barrel import of the run. It re-renders every pre-barrel manifest and compares
 * to disk: if any differs, a codegen step ran a barrel import while a pre-barrel
 * manifest was stale — which Bun's frozen ESM cache makes unrecoverable for the
 * rest of the build. We throw immediately with an actionable message rather than
 * let `generateConfigOrigins` silently prune freshly-authored overrides.
 */
export async function assertPreBarrelManifestsFresh(
  root: AppPath,
): Promise<void> {
  const stale: { m: PreBarrelManifest; rel: string }[] = [];
  for (const m of preBarrelManifests) {
    const file = m.path(root);
    // Through the same funnel `writePreBarrelManifest` writes with — comparing
    // raw render output against formatted bytes on disk would report every
    // manifest as stale and abort the build.
    const next = await formatGenerated({
      file,
      content: await m.render(root),
    });
    const existing = existsSync(file) ? readFileSync(file, "utf8") : "";
    if (next !== existing) stale.push({ m, rel: relative(root, file) });
  }
  if (stale.length === 0) return;

  const list = stale.map((s) => `  - ${s.rel} (${s.m.id})`).join("\n");
  throw new Error(
    `[pre-barrel-guard] A barrel was imported before the pre-barrel manifest ` +
      `phase finished. The following pre-barrel manifest(s) are stale at the ` +
      `freeze point:\n${list}\n\n` +
      `These manifests are imported by plugin barrels at module-load. Bun freezes ` +
      `a module on its first import() and a later disk write cannot invalidate it, ` +
      `so every pre-barrel manifest MUST be regenerated before the first barrel ` +
      `import. A codegen step ran a barrel import (e.g. building the enriched ` +
      `plugin tree) before the pre-barrel phase completed.\n\n` +
      `Fix: ensure the offending step runs AFTER the preBarrelManifests loop in ` +
      `regenerateManifestCodegen, and that the manifest is registered in ` +
      `preBarrelManifests (codegen/core/pre-barrel-manifests.ts).`,
  );
}
