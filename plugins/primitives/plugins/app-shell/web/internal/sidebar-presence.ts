import { defineSurfacePresence } from "./surface-presence";

// Which surfaces (tab ids) currently draw the shell's sidebar — published by
// every mounted `AppShellLayout` that renders its `sidebarSlot`.
const sidebarPresence = defineSurfacePresence();

/** Record that a sidebar is drawn on `surfaceId` while the caller is mounted. */
export function useRecordSidebarDrawn(surfaceId: string | undefined): void {
  sidebarPresence.useRecord(surfaceId);
}

/**
 * Whether the shell draws a sidebar on the surface `surfaceId` (a tab id) —
 * derived from what is mounted, never declared by the app. The desktop's
 * window chrome reads it for a window's shown tab: an app with a sidebar gets
 * the classic tinted titlebar, one without the seamless bar.
 */
export function useSidebarDrawnOn(surfaceId: string | undefined): boolean {
  return sidebarPresence.useDrawnOn(surfaceId);
}
