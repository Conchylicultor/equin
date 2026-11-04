// Reclaim's one read of codegen, in a module of its own so reclaim can load it
// lazily (`await import("./named-registries")`). Codegen's barrel is the build
// pipeline (docgen, the lint and format cores — eslint, @typescript-eslint,
// ~300 npm modules), and reclaim is in every backend's boot closure through the
// worktree-cleanup reaper: statically, this import was main boot's single
// largest (0.4–1.4 s, 3.5–5.6 s on a cold cache) for a sweep no boot runs.
// `boot:closure-no-dev-tooling` keeps it out.
import type { AppPath } from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import { listNamedCompositionRegistries } from "@plugins/framework/plugins/tooling/plugins/codegen/core";

/** The files of `composition`'s per-name registries in the checkout at `root`. */
export function namedRegistryFiles(
  root: AppPath,
  composition: string,
): string[] {
  return listNamedCompositionRegistries(root)
    .filter((r) => r.name === composition)
    .map((r) => r.file);
}
