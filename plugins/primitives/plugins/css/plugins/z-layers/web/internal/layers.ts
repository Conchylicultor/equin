/**
 * The single source for the semantic z-layer vocabulary + the name→class map.
 * The ladder itself (the --z-* vars and matching `z-*` @utility classes) is
 * defined in ui-kit/web/theme/app.css; this module is the TS-side resolver so
 * positioning primitives turn a `layer` prop into a class without each copying
 * the map. NEVER a raw z-number.
 */

// name → the `z-*` @utility class (defined in app.css). Source of truth for the
// full ladder and the ZLayer union.
const Z_LAYER_CLASS = {
  base: "z-base",
  raised: "z-raised",
  nav: "z-nav",
  float: "z-float",
  overlay: "z-overlay",
  popover: "z-popover",
  guide: "z-guide",
  draw: "z-draw",
  max: "z-max",
} as const;

/** Every named layer on the ladder. */
export type ZLayer = keyof typeof Z_LAYER_CLASS;

/** In-tree levels (0–40): elements that stay in document flow — sticky headers,
 *  in-pane floats, full-pane overlays. Out-stacked by every portaled layer. */
export type InTreeLayer = "base" | "raised" | "nav" | "float" | "overlay";

/** Portaled top layers (50–9999): elements portaled to <body> that must
 *  out-stack all in-tree chrome — modals/lightboxes, draw overlay, banners. */
export type PortaledLayer = "popover" | "guide" | "draw" | "max";

// Compile-time guard: the two tiers must EXACTLY partition the ladder, so a new
// layer added to Z_LAYER_CLASS can't silently belong to neither tier.
type _Partition = [InTreeLayer | PortaledLayer] extends [ZLayer]
  ? [ZLayer] extends [InTreeLayer | PortaledLayer]
    ? true
    : never
  : never;
const _assertPartition: _Partition = true;
void _assertPartition;

/** Resolve a named z-layer to its `z-*` utility class — the one place the
 *  name→class map is read. */
export function zLayerClass(layer: ZLayer): string {
  return Z_LAYER_CLASS[layer];
}
