// The deployed composition's committed config layer — a composition module
// (`web-artifacts/core/composition-modules.ts`), served from the composition's
// registry artifact rather than from this plugin's, so its content is the
// deployed composition's own. Generated per composition by codegen's
// `config-git-layer-gen.ts` (gitignored, `.generated/composition-modules/`); typed here
// rather than through a tsconfig path, so the program type-checks before any
// build has generated it.
declare module "@composition-config-layer" {
  import type { GitLayerDocument } from "@plugins/config_v2/core";

  /** storePath → its resolved git-layer document. */
  export const gitLayer: Readonly<Record<string, GitLayerDocument>>;
}
