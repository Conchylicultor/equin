import { z } from "zod";
import { defineEndpoint } from "@plugins/infra/plugins/endpoints/core";
import { liveValue } from "@plugins/network/plugins/live/core";

/**
 * The shape of every Google API key: `AIza` plus 35 URL-safe characters. Checked
 * on write (server) and before enabling Save (web), so a pasted Places key's
 * neighbour — a client id, a secret, a stray space — is refused with a reason
 * instead of surfacing later as a blank map.
 */
export const BROWSER_KEY_PATTERN = /^AIza[0-9A-Za-z_-]{35}$/;

/**
 * A Map ID as the Cloud Console shows it (hex, or Google's `DEMO_MAP_ID`).
 * Lenient on purpose: a wrong-but-well-formed id is caught where it matters —
 * the map reports how Google drew it (vector or not), see `useMapIdCheck`.
 */
export const MAP_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;

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

/** What the user submits for the key: the browser key alone. */
export const MapsBrowserConfigInputSchema = z.object({
  browserKey: z
    .string()
    .trim()
    .regex(BROWSER_KEY_PATTERN, "Not a Google API key (expected AIza…)"),
});
export type MapsBrowserConfigInput = z.infer<
  typeof MapsBrowserConfigInputSchema
>;

/**
 * The browser config as the live value carries it. `unset` is an answer (no
 * file on this machine), distinct from not-loaded-yet — which is the read's
 * `pending`, never a value.
 */
export const MapsBrowserConfigValueSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("unset") }),
  z.object({
    kind: z.literal("set"),
    browserKey: z.string(),
    /**
     * The vector map's Map ID, or `null`: without one the map is the raster
     * map, styled inline by `BASEMAP_STYLE`. With one it is Google's vector
     * map (fractional, animated zoom), styled by the cloud style attached to
     * the Map ID — Google ignores inline styles there.
     */
    mapId: z.string().nullable(),
  }),
]);
export type MapsBrowserConfigValue = z.infer<
  typeof MapsBrowserConfigValueSchema
>;

/**
 * The host-global browser config, pushed to every tab of every checkout: the
 * server notifies on its own writes and on any out-of-band change to the file
 * (another checkout's write, a hand edit), via a file watcher.
 */
export const mapsBrowserConfig = liveValue("google-maps.browser-config", {
  schema: MapsBrowserConfigValueSchema,
});

/**
 * Store (or replace) the browser key. A stored Map ID is kept.
 *
 * There is no server-side verification, unlike the Places key: a browser key is
 * restricted to HTTP referrers, and a request from the server either carries no
 * referrer (Google refuses it — a correct key would read as broken) or forges
 * one (which proves nothing about what a real browser will see). The renderer's
 * `gm_authFailure` callback, raised in the actual page against the actual
 * referrer, is the only honest verifier.
 */
export const setMapsBrowserConfig = defineEndpoint({
  route: "POST /api/google-maps/browser-config",
  body: MapsBrowserConfigInputSchema,
});

/**
 * Store (or replace) the Map ID. Refused (409) while no browser key is stored:
 * a Map ID without a key has no map to draw, so it is not a state to hold.
 * Like the key, nothing is verified here — the renderer reports how Google
 * actually drew the map.
 */
export const MapsMapIdInputSchema = z.object({
  mapId: z
    .string()
    .trim()
    .regex(MAP_ID_PATTERN, "Not a Map ID (letters, digits, - and _)"),
});
export type MapsMapIdInput = z.infer<typeof MapsMapIdInputSchema>;

export const setMapsMapId = defineEndpoint({
  route: "POST /api/google-maps/map-id",
  body: MapsMapIdInputSchema,
});

/** Remove the Map ID: every map goes back to the raster map. */
export const clearMapsMapId = defineEndpoint({
  route: "DELETE /api/google-maps/map-id",
});

/** Remove the browser config (key and Map ID), turning every live map back into its setup prompt. */
export const clearMapsBrowserConfig = defineEndpoint({
  route: "DELETE /api/google-maps/browser-config",
});
