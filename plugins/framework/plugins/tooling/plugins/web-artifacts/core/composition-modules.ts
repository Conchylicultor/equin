// The composition artifact's modules: what one deploy's REGISTRY artifact
// serves. Everything else in a fleet is a per-plugin artifact shared by every
// composition holding the plugin; these are the modules whose content depends
// on WHICH composition is deployed, so they cannot live in any plugin's
// artifact (a shared artifact would carry one composition's content into all of
// them). Each sits behind a FIXED bare specifier the import map points at the
// deployed composition's registry artifact.

/** The web registry: the plugin loaders + the composition's identity. */
export const COMPOSITION_REGISTRY_SPECIFIER = "@composition-web-registry";

/**
 * The committed config layer (repo `config/`) restricted to the composition's
 * plugins — what a demo scope's browser server answers `config-v2.*` from.
 * Emitted by codegen's `config-git-layer-gen.ts`; read by config_v2's demo serve.
 */
export const COMPOSITION_CONFIG_LAYER_SPECIFIER = "@composition-config-layer";

/** Every composition-module specifier: external to every artifact build. */
export const COMPOSITION_SPECIFIERS: ReadonlySet<string> = new Set([
  COMPOSITION_REGISTRY_SPECIFIER,
  COMPOSITION_CONFIG_LAYER_SPECIFIER,
]);

/** The config layer's file inside the registry artifact (beside `index.js`). */
export const CONFIG_LAYER_ARTIFACT_FILE = "config-layer.js";

/**
 * Where generated composition-module sources live (repo-relative, gitignored):
 * OUTSIDE `plugins/`, deliberately. Every plugin-tree scanner walks a plugin's
 * runtime folders on disk — the token-usage facet, an artifact's own-file
 * address — so pure data generated into one (it holds arbitrary config text)
 * would be read as that plugin's source: a token "use" its docs claim only
 * after a build wrote the file, and an address that moves on every config edit.
 */
export const COMPOSITION_MODULES_REL = ".generated/composition-modules";

/**
 * The config layer SOURCE file name for one composition. Unlike the web
 * registry, no composition's is committed, so main is not special-cased: every
 * composition is `config-layer.<id>.ts`. The one spelling codegen's writer and
 * the fleet planner both read.
 */
export function compositionConfigLayerFileName(composition: string): string {
  return `config-layer.${composition}.ts`;
}
