import { disc } from "../kit/night";
import type { Frame } from "./frame";

/**
 * Chapter 3 — a personal OS, a desktop without borders. Once the zoom has
 * moved on, chapter 2 stops where it is and its window comes apart
 * (`apart.ts`): each app it shows becomes a window of this desktop, floating on
 * the orbit (`os-orbit.ts`). The frame itself is only the layers they are put
 * in: the orbit's rings behind, the windows, the dock in front.
 */
export function desktopFrame(prefix: string): Frame {
  return {
    back: disc(`${prefix}g3`),
    front:
      '<g class="zb-os-back"></g><g class="zb-apart"></g><g class="zb-os-front"></g>',
    selfFades: true,
  };
}
