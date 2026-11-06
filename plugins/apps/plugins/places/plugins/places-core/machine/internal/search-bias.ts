import type { SearchTextBias } from "@plugins/integrations/plugins/google-maps/plugins/places-api/server";
import type { PlaceBounds } from "../../core";

/** Google refuses a rectangle bias wider than this, in degrees of longitude. */
const MAX_BIAS_SPAN_DEG = 180;

/**
 * The map's view as a Text Search bias — or none when the view is wider than
 * Google takes (a zoomed-out world map): such a box biases toward nothing,
 * and Google refuses it outright.
 */
export function searchBias(bounds: PlaceBounds): SearchTextBias | undefined {
  const { low, high } = bounds;
  const span =
    low.lng <= high.lng ? high.lng - low.lng : 360 - (low.lng - high.lng);
  if (span >= MAX_BIAS_SPAN_DEG) return undefined;
  return { kind: "rectangle", low, high };
}
