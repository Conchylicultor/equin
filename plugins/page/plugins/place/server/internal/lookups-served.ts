import { serveValue } from "@plugins/network/plugins/live/server";
import { PlaceLookupRefusal, placeResolve, placeSearch } from "../../core";
import {
  getPlaceProvider,
  placeProviderIds,
  type PlaceProvider,
} from "./registry";

/** Resolve a provider id, or refuse with the ids that DO exist. */
function requireProvider(id: string): PlaceProvider {
  const provider = getPlaceProvider(id);
  if (!provider) {
    const known = placeProviderIds();
    throw new PlaceLookupRefusal(
      "unknown-provider",
      `Unknown place provider: ${id}. Registered: ${known.length > 0 ? known.join(", ") : "(none)"}`,
    );
  }
  return provider;
}

/**
 * Generic search dispatch. The provider's own failures propagate untouched —
 * there is deliberately no empty-array fallback, because an empty suggestion
 * list must only ever mean "the provider found nothing".
 */
export const placeSearchServed = serveValue(placeSearch, {
  source: "external",
  changes: {
    fixed: {
      reason:
        "a third-party answer to one query (one provider round of suggestions): no change signal",
    },
  },
  loader: async ({ providerId, q, session }) => ({
    suggestions: await requireProvider(providerId).search(q, session),
  }),
});

/** Generic resolve dispatch. Same rule: a provider that cannot answer throws. */
export const placeResolveServed = serveValue(placeResolve, {
  source: "external",
  changes: {
    fixed: {
      reason:
        "a third-party answer about one place in one search round: no change signal, and the block copies it into its data and stops reading",
    },
  },
  loader: ({ providerId, placeId, session }) =>
    requireProvider(providerId).resolve(placeId, session),
});
