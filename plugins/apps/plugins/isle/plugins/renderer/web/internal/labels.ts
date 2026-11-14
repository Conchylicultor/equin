// The map labels' state machine: each group (island names, district names) is
// shown or hidden by the zoom relative to the zoom that fits the island in
// view (r = zoom / fitZ), with hysteresis, and its opacity then eases to 0 or 1
// over LABEL_FADE seconds of frame time — never left in between, whether or
// not the zoom still moves (the frame loop keeps stepping it).

/** Seconds a group takes to fade fully in or out. */
export const LABEL_FADE = 0.3;
/** District names turn on inside [0.9, 1.3] × fitZ … */
export const LABEL_ON = [0.9, 1.3] as const;
/** … and off again outside [0.8, 1.4]. Island names: on at r ≤ 1.3, off above 1.4. */
export const LABEL_OFF = [0.8, 1.4] as const;

export interface LabelGroup {
  readonly on: boolean;
  /** Opacity progress, 0 … 1 (eased by the caller). */
  readonly p: number;
}
export interface LabelState {
  readonly isl: LabelGroup;
  readonly dist: LabelGroup;
}

export const LABELS_HIDDEN: LabelState = {
  isl: { on: false, p: 0 },
  dist: { on: false, p: 0 },
};

const fadeTo = (on: boolean, p: number, dt: number): LabelGroup => ({
  on,
  p: Math.max(0, Math.min(1, p + ((on ? 1 : -1) * dt) / LABEL_FADE)),
});

/**
 * One frame: `r` is zoom / fitZ, `dt` the frame's seconds (`Infinity` to jump
 * straight to the end — reduced motion).
 */
export function stepLabels(s: LabelState, r: number, dt: number): LabelState {
  const distOn = s.dist.on
    ? r >= LABEL_OFF[0] && r <= LABEL_OFF[1]
    : r >= LABEL_ON[0] && r <= LABEL_ON[1];
  const islOn = s.isl.on ? r <= LABEL_OFF[1] : r <= LABEL_ON[1];
  return {
    isl: fadeTo(islOn, s.isl.p, dt),
    dist: fadeTo(distOn, s.dist.p, dt),
  };
}
