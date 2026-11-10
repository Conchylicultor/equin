/**
 * The basemap style every Google map here wears: Google's own places (shops,
 * museums, restaurants) hidden, since the map's content is the user's pins.
 * ONE rule, two spellings: the raster map passes it inline (`styles`), and the
 * vector map's cloud style is created from it — the Live map setup hands
 * `BASEMAP_STYLE_JSON` to the Cloud Console's JSON import — so the two cannot
 * drift apart.
 */
export const BASEMAP_STYLE = [
  {
    featureType: "poi",
    elementType: "labels",
    stylers: [{ visibility: "off" }],
  },
] as const satisfies readonly {
  featureType: string;
  elementType: string;
  stylers: readonly { visibility: "off" | "on" | "simplified" }[];
}[];

/** `BASEMAP_STYLE` as the JSON the Cloud Console's style import takes. */
export const BASEMAP_STYLE_JSON = JSON.stringify(BASEMAP_STYLE, null, 2);
