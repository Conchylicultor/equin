import type { MapPin } from "@plugins/map/core";

/** The pin type of one of Sonnet's picks on the map (`GeoMap.Pin` key). */
export const ASK_PICK_PIN_TYPE = "places.ask-pick";

/** What a pick's pin carries in `MapPin.data`: its rank. */
export interface AskPickPinData {
  /** 1-based: the pick's place in Sonnet's answer (best first). */
  n: number;
}

/** A pick pin's data; absent is a wiring bug. */
export function readAskPickData(pin: MapPin): AskPickPinData {
  const data: unknown = pin.data;
  if (typeof data !== "object" || data === null || !("n" in data)) {
    throw new Error(`Ask pick pin "${pin.id}" carries no AskPickPinData`);
  }
  return data as AskPickPinData;
}
