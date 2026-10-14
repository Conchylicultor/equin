// ── A smooth clock over a stepping time source ──────────────────────────────
//
// Some clocks report time in steps: an embedded player's IFrame API posts the
// current time a few times a second; an AudioContext's `currentTime` advances
// once per rendered audio buffer, so two frames read the same time and the
// next one jumps by two. Anything slaved to such a clock — a synth playing
// along, a playhead scrolled every frame — hears or sees every step as a slip.
// The model below turns the readings into a continuous clock: a line (when,
// where, rate) that is refitted on every new reading and SLEWED toward it, at
// most 5 % faster or slower than the rate, so a small disagreement is absorbed
// over time instead of jumped. A large one (a seek) snaps.

/** Disagreements past this many seconds are jumps (a seek), not jitter: snap. */
export const SMOOTH_CLOCK_SNAP_SEC = 0.15;
/** The most the clock speeds up or slows down to absorb a disagreement, as a fraction of the rate. */
export const SMOOTH_CLOCK_MAX_SLEW = 0.05;

export interface SmoothClockModel {
  /**
   * Feed one reading: the source said `media` seconds at wall time `perfMs`
   * (`performance.now()` milliseconds), playing at `rate`. A reading equal to
   * the last one carries no news and is ignored.
   */
  observe(media: number, perfMs: number, rate: number): void;
  /** The smoothed media time at `perfMs`, or `null` before the first reading. */
  at(perfMs: number): number | null;
  /** Forget everything: the next reading snaps (after a pause or a stall). */
  reset(): void;
}

interface Fit {
  perfMs: number;
  media: number;
  rate: number;
  /** The disagreement still to absorb, in media seconds (signed). */
  error: number;
}

export function createSmoothClockModel(): SmoothClockModel {
  let fit: Fit | null = null;
  let lastReading: number | null = null;

  const at = (perfMs: number): number | null => {
    if (fit === null) return null;
    const dt = Math.max(0, (perfMs - fit.perfMs) / 1000);
    const budget = SMOOTH_CLOCK_MAX_SLEW * fit.rate * dt;
    const absorbed =
      Math.sign(fit.error) * Math.min(Math.abs(fit.error), budget);
    return fit.media + dt * fit.rate + absorbed;
  };

  return {
    observe(media, perfMs, rate) {
      if (fit !== null && media === lastReading && rate === fit.rate) return;
      lastReading = media;
      const predicted = at(perfMs);
      if (
        fit === null ||
        predicted === null ||
        rate !== fit.rate ||
        Math.abs(media - predicted) > SMOOTH_CLOCK_SNAP_SEC
      ) {
        fit = { perfMs, media, rate, error: 0 };
        return;
      }
      // Re-base on where the clock is NOW (so it never jumps), and absorb the
      // whole disagreement from here at the slew budget.
      fit = { perfMs, media: predicted, rate, error: media - predicted };
    },
    at,
    reset() {
      fit = null;
      lastReading = null;
    },
  };
}
