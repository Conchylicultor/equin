import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { z } from "zod";
import { defineStore } from "@plugins/primitives/plugins/dom/plugins/web-storage/web";

/** The button's diameter (px). */
export const FAB_SIZE = 56;
/** The gap kept between the button and the side edge it rests on (px). */
const EDGE_GAP = 12;
/** The highest the button rests: below the top header's line (px). */
const MIN_TOP = 64;
/** The gap kept under the button at its lowest (px). */
const BOTTOM_GAP = 20;
/** Where it starts, before it was ever moved: this far above the bottom (px). */
const FIRST_BOTTOM_GAP = 28;

const placeSchema = z.object({
  side: z.enum(["left", "right"]),
  /** The button's top edge, in viewport px (clamped to the viewport on read). */
  top: z.number(),
});

/** Where the button rests: the side edge it snapped to and its height. */
export type FabPlace = z.infer<typeof placeSchema>;

/**
 * The button's place, one per browser profile: the one button is mounted once
 * on the page, so it rests in the same place in every app and across reloads.
 */
const placeStore = defineStore({
  owner: "apps-core.phone-actions.place",
  pageWide: {
    reason:
      "where the page's own phone action button rests, outside every scope",
  },
  label: "Phone action button position",
  area: "local",
  cap: "1 KB",
  ttl: Infinity,
  whenFull: "refuse",
  schema: placeSchema,
});

function readPlace(): FabPlace | null {
  const read = placeStore.read();
  return read.kind === "value" ? read.value : null;
}

/**
 * The stored place and its setter (persisted; other tabs follow). `null`
 * until the button was first moved: it then starts at the bottom right.
 */
export function useFabPlace(): [FabPlace | null, (place: FabPlace) => void] {
  const [place, setPlaceState] = useState(readPlace);
  useEffect(
    () => placeStore.subscribe("", () => setPlaceState(readPlace())),
    [],
  );
  const setPlace = useCallback((next: FabPlace) => {
    setPlaceState(next);
    placeStore.write("", next);
  }, []);
  return [place, setPlace];
}

export interface Viewport {
  w: number;
  h: number;
}

function subscribeResize(onChange: () => void): () => void {
  window.addEventListener("resize", onChange);
  return () => window.removeEventListener("resize", onChange);
}

/** A string, so an unchanged size is an unchanged snapshot. */
function viewportKey(): string {
  return `${window.innerWidth}x${window.innerHeight}`;
}

function noViewport(): null {
  return null;
}

/**
 * The viewport's size, following window resizes. `null` where there is no
 * viewport (a static render): unknown, never a made-up size.
 */
export function useViewport(): Viewport | null {
  const key = useSyncExternalStore(subscribeResize, viewportKey, noViewport);
  if (key === null) return null;
  const [w, h] = key.split("x").map(Number);
  return { w: w!, h: h! };
}

/** The top edge, kept on screen in this viewport. */
function clampTop(top: number, vp: Viewport): number {
  return Math.min(Math.max(top, MIN_TOP), vp.h - FAB_SIZE - BOTTOM_GAP);
}

/** The left edge of a button resting on `side`. */
export function sideLeft(side: FabPlace["side"], vp: Viewport): number {
  return side === "left" ? EDGE_GAP : vp.w - FAB_SIZE - EDGE_GAP;
}

/**
 * Where a stored place puts the button in this viewport: on its side edge,
 * its height kept on screen — so a window that shrank never loses it.
 */
export function restingPoint(
  place: FabPlace | null,
  vp: Viewport,
): { left: number; top: number; side: FabPlace["side"] } {
  const side = place?.side ?? "right";
  const top = place?.top ?? vp.h - FAB_SIZE - FIRST_BOTTOM_GAP;
  return { left: sideLeft(side, vp), top: clampTop(top, vp), side };
}

/** The place a drop at (`left`, `top`) snaps to: the nearer side edge. */
export function snapPlace(left: number, top: number, vp: Viewport): FabPlace {
  return {
    side: left + FAB_SIZE / 2 < vp.w / 2 ? "left" : "right",
    top: clampTop(top, vp),
  };
}
