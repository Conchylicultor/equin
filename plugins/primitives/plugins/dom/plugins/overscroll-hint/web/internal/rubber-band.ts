/**
 * The rubber-band's physics, framework-free and DOM-free: wasted scroll deltas
 * in, a displacement per frame out.
 *
 * Two stages, so input arriving in bursts never shows as a shake:
 *
 *   - **Pull** — where the band wants to be. Every wasted delta stretches it
 *     through a saturating curve (`bandOf`: 1:1·STIFFNESS at rest, asymptote
 *     MAX_PULL), and it relaxes exponentially toward rest while no finger is
 *     down. Pushes are instant and relaxing is continuous, so on its own the
 *     pull is a sawtooth: out on a frame with a wheel event, back on a frame
 *     without one — a trackpad sends ~60 events/s, a display draws 120 frames.
 *   - **Offset** — what is drawn. A critically damped spring follows the pull,
 *     filtering the sawtooth out (a 60 Hz ripple is attenuated ~70×), so the
 *     content moves out and back once, never back-and-forth. Stepped
 *     analytically, so the motion is the same at any frame rate.
 *
 * A trackpad's momentum tail keeps pushing with shrinking deltas: the relax
 * wins as they shrink, so the band recedes while momentum is still arriving
 * rather than staying out until it ends.
 */

/** The furthest the band can stretch, in px (the curve's asymptote). */
const MAX_PULL = 48;
/** The curve's slope at rest: px of pull per px of wasted delta. */
const STIFFNESS = 0.5;
/** Relax time constant of the pull (ms) while no finger is down. */
const RELAX_TAU_MS = 70;
/** Natural frequency of the spring the drawn offset follows the pull with (rad/s). */
const FOLLOW_OMEGA = 45;
/** Below this (px) the band is at rest — a snap from here is invisible. */
const REST_EPS = 0.25;
/**
 * Below this (px/s, ~0.08 px a frame) the drawn offset has stopped. In px/s,
 * not px: a spring following a relaxing target still moves several px/s at
 * a quarter pixel out, and holding out for less kept the bounce alive for
 * another ~200 ms of invisible motion.
 */
const REST_SPEED = 5;
/**
 * Clamp for one frame's dt, so the first frame after a backgrounded tab does
 * not teleport. Generous: the spring is solved exactly, so a slow frame on a
 * loaded machine is best advanced by its real length.
 */
const MAX_FRAME_MS = 100;

/** Pull (px) for a raw stretch (px of wasted delta); odd, saturating at MAX_PULL. */
function bandOf(stretch: number): number {
  const s = Math.abs(stretch);
  return (
    Math.sign(stretch) * MAX_PULL * (1 - 1 / (1 + (STIFFNESS * s) / MAX_PULL))
  );
}

/** The raw stretch a pull came from — `bandOf`'s inverse. */
function stretchOf(pull: number): number {
  const p = Math.min(Math.abs(pull), MAX_PULL * 0.999);
  return (Math.sign(pull) * p) / (STIFFNESS * (1 - p / MAX_PULL));
}

export interface RubberBand {
  /**
   * Advance by one frame of `dtMs`, during which the wasted deltas summing to
   * `delta` arrived (in scroll direction: positive = toward the end, so the
   * content moves up/left; 0 for a frame without any). `holding`: a finger is
   * down, so the pull stays where the finger put it instead of relaxing.
   *
   * One call, so the order is fixed: the input arrived DURING the frame, so it
   * is applied at the frame's middle — half the relax before it, half after.
   * Relaxing it over the whole frame, as if it had come at the start, dropped
   * the band on every long frame (a shake on a loaded machine, frames of
   * 30–80 ms); relaxing none of it made the pull depend on the frame rate.
   */
  frame(dtMs: number, delta: number, holding: boolean): void;
  /** The displacement to draw, in px (negative = content moved up/left). */
  readonly offset: number;
  /** Whether the band is back at rest (nothing left to draw or animate). */
  readonly atRest: boolean;
}

export function createRubberBand(): RubberBand {
  let pull = 0; // target displacement, in the pushed direction (positive = toward the end)
  let offset = 0; // drawn displacement (signed against `pull`)
  let velocity = 0; // of `offset`, px/s

  return {
    frame(dtMs, delta, holding) {
      const ms = Math.min(MAX_FRAME_MS, Math.max(0, dtMs));
      const relaxHalf = holding ? 1 : Math.exp(-ms / 2 / RELAX_TAU_MS);
      pull *= relaxHalf;
      if (delta !== 0) pull = bandOf(stretchOf(pull) + delta);
      pull *= relaxHalf;
      // Critically damped spring toward `target`, exact for a target held
      // constant over the step: x(t) = (x0 + (v0 + ωx0)·t)·e^(−ωt).
      const target = -pull;
      const t = ms / 1000;
      const x0 = offset - target;
      const c = velocity + FOLLOW_OMEGA * x0;
      const decay = Math.exp(-FOLLOW_OMEGA * t);
      offset = target + (x0 + c * t) * decay;
      velocity = (velocity - FOLLOW_OMEGA * t * c) * decay;
      if (
        !holding &&
        Math.abs(pull) < REST_EPS &&
        Math.abs(offset) < REST_EPS &&
        Math.abs(velocity) < REST_SPEED
      ) {
        pull = 0;
        offset = 0;
        velocity = 0;
      }
    },
    get offset() {
      return offset;
    },
    get atRest() {
      return pull === 0 && offset === 0 && velocity === 0;
    },
  };
}
