import { useSyncExternalStore } from "react";
import type { Room } from "./layout";

/**
 * The size a page gets in this browser window (`innerWidth × innerHeight`, CSS
 * pixels) — the room the real app has on the viewer's own machine, which the
 * canvas's This window size lays a prototype out at. Follows the window as it
 * is resized.
 *
 * `null` while the window is not known: a server render (a static render to
 * HTML) has no window, so it has no size to answer.
 */
export function useWindowSize(): Room | null {
  const key = useSyncExternalStore(subscribe, snapshot, noWindow);
  if (key === null) return null;
  const [w, h] = key.split("x").map(Number);
  return { w: w!, h: h! };
}

function subscribe(onChange: () => void): () => void {
  window.addEventListener("resize", onChange);
  return () => window.removeEventListener("resize", onChange);
}

/** A string, so an unchanged size is an unchanged snapshot. */
function snapshot(): string {
  return `${String(window.innerWidth)}x${String(window.innerHeight)}`;
}

function noWindow(): null {
  return null;
}
