import { defineSurfacePresence } from "./surface-presence";

// Which surfaces (tab ids) currently draw the brand. A surface that draws none
// — an app with no shell chrome (a launcher gallery, a full-bleed site) — is
// one where global chrome must stand in for the brand when nothing else shows a
// way out.
const brandPresence = defineSurfacePresence();

/** Record that a brand is drawn on `surfaceId` while the caller is mounted. */
export function useRecordBrandDrawn(surfaceId: string | undefined): void {
  brandPresence.useRecord(surfaceId);
}

/**
 * Whether the brand is drawn on the surface `surfaceId` (a tab id) — derived
 * from what is mounted, never declared by the app, so it cannot disagree with
 * the screen: an app whose shell places the brand answers `true`, an app with
 * no shell chrome (or a pane with no header) answers `false`.
 */
export function useBrandDrawnOn(surfaceId: string | undefined): boolean {
  return brandPresence.useDrawnOn(surfaceId);
}
