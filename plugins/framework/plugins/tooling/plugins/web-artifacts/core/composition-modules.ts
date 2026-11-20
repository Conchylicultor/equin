// The composition artifact's modules: what one deploy's REGISTRY artifact
// serves. Everything else in a fleet is a per-plugin artifact shared by every
// composition holding the plugin; these are the modules whose content depends
// on WHICH composition is deployed, so they cannot live in any plugin's
// artifact (a shared artifact would carry one composition's content into all of
// them). Each sits behind a FIXED bare specifier the import map points at the
// deployed composition's registry artifact. Two: the web registry, and the
// web list catalog kept to the composition's plugins (`page-catalog.ts`). (The committed config layer was the second until a demo's config
// moved into its browser host, which bundles all of `config/` itself.)

/** The web registry: the plugin loaders + the composition's identity. */
export const COMPOSITION_REGISTRY_SPECIFIER = "@composition-web-registry";

/**
 * The list catalog the page is shipped: every web list and every entry's fact
 * of the composition's plugins (`catalog.js` beside the registry's `index.js`).
 */
export const COMPOSITION_CATALOG_SPECIFIER = "@composition-web-catalog";

/** The catalog module's file name inside the registry artifact. */
export const COMPOSITION_CATALOG_FILE = "catalog.js";

/**
 * The catalog WITH the composition's on-demand plugins (a browser host's page
 * scope): loaded with those plugins when a scope asks for them, never upfront
 * — their facts are not the page's until then.
 */
export const COMPOSITION_ON_DEMAND_CATALOG_SPECIFIER =
  "@composition-web-catalog-on-demand";

/** The on-demand catalog module's file name inside the registry artifact. */
export const COMPOSITION_ON_DEMAND_CATALOG_FILE = "catalog-on-demand.js";

/** Every composition-module specifier: external to every artifact build. */
export const COMPOSITION_SPECIFIERS: ReadonlySet<string> = new Set([
  COMPOSITION_REGISTRY_SPECIFIER,
  COMPOSITION_CATALOG_SPECIFIER,
  COMPOSITION_ON_DEMAND_CATALOG_SPECIFIER,
]);
