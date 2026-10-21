// The composition artifact's modules: what one deploy's REGISTRY artifact
// serves. Everything else in a fleet is a per-plugin artifact shared by every
// composition holding the plugin; these are the modules whose content depends
// on WHICH composition is deployed, so they cannot live in any plugin's
// artifact (a shared artifact would carry one composition's content into all of
// them). Each sits behind a FIXED bare specifier the import map points at the
// deployed composition's registry artifact. Today there is one: the web
// registry. (The committed config layer was the second until a demo's config
// moved into its browser host, which bundles all of `config/` itself.)

/** The web registry: the plugin loaders + the composition's identity. */
export const COMPOSITION_REGISTRY_SPECIFIER = "@composition-web-registry";

/** Every composition-module specifier: external to every artifact build. */
export const COMPOSITION_SPECIFIERS: ReadonlySet<string> = new Set([
  COMPOSITION_REGISTRY_SPECIFIER,
]);
