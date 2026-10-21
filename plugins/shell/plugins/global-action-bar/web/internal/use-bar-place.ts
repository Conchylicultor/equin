import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { z } from "zod";
import { defineStore } from "@plugins/primitives/plugins/dom/plugins/web-storage/web";

const barPlaceSchema = z.discriminatedUnion("kind", [
  // In its slot at the surface's top-right corner, which the top header
  // reserves (the safe area).
  z.object({ kind: z.literal("home") }),
  // Dropped anywhere else: the centre of its collapsed footprint, as fractions
  // of the viewport, so it keeps its place in the window as the window resizes.
  z.object({
    kind: z.literal("free"),
    x: z.number().min(0).max(1),
    y: z.number().min(0).max(1),
  }),
]);

/** Where the floating action bar sits. */
export type BarPlace = z.infer<typeof barPlaceSchema>;

const HOME: BarPlace = { kind: "home" };

/**
 * The bar's place, kept per browser profile: ONE place, read by the one host
 * mounted at the root, so it is the same in every app and every surface mode
 * the bar floats in (solo, the desktop) — and across reloads and tabs.
 */
const barPlaceStore = defineStore({
  owner: "global-action-bar.place",
  label: "Action bar position",
  area: "local",
  cap: "1 KB",
  ttl: Infinity,
  whenFull: "refuse",
  schema: barPlaceSchema,
});

function readPlace(): BarPlace {
  const read = barPlaceStore.read();
  return read.kind === "value" ? read.value : HOME;
}

/** The bar's place and its setter (persisted; other tabs follow). */
export function useBarPlace(): [BarPlace, (place: BarPlace) => void] {
  const [place, setPlaceState] = useState(readPlace);
  useEffect(
    () => barPlaceStore.subscribe("", () => setPlaceState(readPlace())),
    [],
  );
  const setPlace = useCallback((next: BarPlace) => {
    setPlaceState(next);
    barPlaceStore.write("", next);
  }, []);
  return [place, setPlace];
}

/** The viewport's size, following window resizes. */
export function useViewportSize(): { w: number; h: number } {
  const key = useSyncExternalStore(subscribeResize, viewportKey);
  const [w, h] = key.split("x").map(Number);
  return { w: w!, h: h! };
}

function subscribeResize(onChange: () => void): () => void {
  window.addEventListener("resize", onChange);
  return () => window.removeEventListener("resize", onChange);
}

/** A string, so an unchanged size is an unchanged snapshot. */
function viewportKey(): string {
  return `${String(window.innerWidth)}x${String(window.innerHeight)}`;
}
