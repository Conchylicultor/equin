/**
 * `@plugins/apps/plugins/sonata/plugins/sources/plugins/ultimate-guitar/core` —
 * pure, framework-free public API for the Ultimate Guitar source.
 *
 * The URL→tab-id resolver, the fetch-error taxonomy and the slim search-result
 * row. The tab model itself (the source id, `UgTab`, the markup parser) is the
 * `tab` child's core, so the alignment child can read it without a cycle.
 */

export { UgSearchResultSchema } from "./search-result";
export type { UgSearchResult } from "./search-result";

export { extractUgTabId } from "./tab-url";

export { UgFetchError } from "./errors";

// The UG side-table shape: the persisted tab, exposing its key to every list of
// songs (registered by this plugin's server and web barrels).
export { ultimateGuitarShape } from "./shape";
export type { UgFetchErrorKind } from "./errors";
