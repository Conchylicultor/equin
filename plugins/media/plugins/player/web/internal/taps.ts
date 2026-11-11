import { DOUBLE_TAP_MS, SEEK_RUN_MS, SIDE_LEFT, SIDE_RIGHT } from "./geometry";

/** Which part of the picture a tap landed on. */
export type Side = "left" | "mid" | "right";

/** The side a tap at `fraction` (0–1) of the picture's width falls on. */
export function sideAt(fraction: number): Side {
  if (fraction < SIDE_LEFT) return "left";
  if (fraction > SIDE_RIGHT) return "right";
  return "mid";
}

/** What the surface remembers between taps. */
export interface TapMemory {
  /** The last tap still waiting to be told apart from a double-tap. */
  last: { at: number; side: Side } | null;
  /** A side seek running: further taps on that side seek again until `until`. */
  run: { side: "left" | "right"; until: number } | null;
}

export const NO_TAPS: TapMemory = { last: null, run: null };

/**
 * What a tap means: a **seek** on its side (the second tap of a double-tap
 * on one side, or any tap on the side of a seek still running — the "keep
 * tapping to go further" gesture), or a **tap** that toggles the controls once
 * `delay` has passed with no second one (at once in the middle, which has no
 * double-tap).
 */
export type TapVerdict =
  { kind: "seek"; side: "left" | "right" } | { kind: "tap"; delay: number };

/** Judge a tap at `now` on `side`, given what came before; the memory to keep after it. */
export function judgeTap(
  memory: TapMemory,
  now: number,
  side: Side,
): { verdict: TapVerdict; memory: TapMemory } {
  if (side !== "mid") {
    const running =
      memory.run !== null && memory.run.side === side && now < memory.run.until;
    const double =
      memory.last !== null &&
      memory.last.side === side &&
      now - memory.last.at < DOUBLE_TAP_MS;
    if (running || double)
      return {
        verdict: { kind: "seek", side },
        memory: { last: null, run: { side, until: now + SEEK_RUN_MS } },
      };
  }
  return {
    verdict: { kind: "tap", delay: side === "mid" ? 0 : DOUBLE_TAP_MS },
    memory: { last: { at: now, side }, run: memory.run },
  };
}
