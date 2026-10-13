import { Place, type PlaceProviderContribution } from "../slots";

/**
 * Every registered place provider, in contribution order. The block reads the
 * whole set and never names one — with a single provider it is used silently,
 * with several the empty state grows a picker.
 */
export function usePlaceProviders(): readonly PlaceProviderContribution[] {
  return Place.Provider.useContributions();
}
