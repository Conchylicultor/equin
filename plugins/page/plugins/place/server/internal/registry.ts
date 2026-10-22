import type { Registration } from "@plugins/framework/plugins/server-core/core";
import type { PlaceSnapshot, PlaceSuggestion } from "../../core";

/**
 * A registered place-lookup provider. The served lookups own the generic
 * dispatch (question → registry → provider); each provider owns only how its source answers
 * two questions and how it reaches its own credential.
 *
 * Collection-consumer separation: nothing in this plugin names a provider, and
 * a provider adds itself with no edit here. That is what makes a second one
 * (OpenStreetMap, a private gazetteer) a new folder rather than a change to the
 * block.
 *
 * One method per question, no `probe`/`extract` split: a place lookup has no
 * polling and no fingerprint, so the two-phase shape the event sources need
 * would buy nothing here.
 */
export interface PlaceProvider {
  /** Registry key. Stored in the block's `data.providerId`, so it must be stable. */
  id: string;
  /**
   * Candidates for a partial query. An EMPTY array means "this provider found
   * nothing" and nothing else — a provider that cannot answer must THROW, so
   * the block reports a broken lookup instead of rendering "no results": a
   * `PlaceLookupRefusal` for a determinate answer (`not-configured`), a plain
   * Error for a failure (network, a malformed answer, a quota or rate limit).
   */
  search(query: string, session: string): Promise<PlaceSuggestion[]>;
  /**
   * The full snapshot for one chosen `placeId`. Throws when it cannot resolve —
   * `PlaceLookupRefusal("not-found")` for an id the provider does not know.
   */
  resolve(placeId: string, session: string): Promise<PlaceSnapshot>;
}

// Module-load-time registry, populated by `definePlaceProvider`'s `register()`
// during the framework's register phase (mirrors `defineWallpaperProvider`).
const registry = new Map<string, PlaceProvider>();

/**
 * Register a place provider. Returns a {@link Registration} — a lazy registry
 * write the framework applies when the token sits in a plugin's `register: [...]`
 * array.
 */
export function definePlaceProvider(
  provider: PlaceProvider,
): PlaceProvider & Registration {
  return {
    ...provider,
    _kind: "place-provider",
    _factory: "definePlaceProvider",
    _doc: { label: provider.id },
    register() {
      if (registry.has(provider.id)) {
        throw new Error(`[place] duplicate place provider id: ${provider.id}`);
      }
      registry.set(provider.id, provider);
    },
  };
}

/** The registered provider for `id`, or `undefined` when nothing claims it. */
export function getPlaceProvider(id: string): PlaceProvider | undefined {
  return registry.get(id);
}

/** Every registered provider id — the list an unknown-id error names. */
export function placeProviderIds(): string[] {
  return [...registry.keys()];
}
