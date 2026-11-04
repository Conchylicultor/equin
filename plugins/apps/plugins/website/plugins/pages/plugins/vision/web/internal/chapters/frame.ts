import type { Timeline } from "../kit/timeline";

/**
 * One chapter's frame of the zoom, as markup: its disc (`back`, which
 * dissolves as the zoom leaves it so the frame melts into its parent) and its
 * drawing (`front`), both in the frame's own 1000 × 1000 units centred on
 * (0, 0). A frame animated by a looping {@link Timeline} carries it.
 */
export interface Frame {
  back: string;
  front: string;
  timeline?: Timeline;
  /** The frame fades its own drawing in (the desktop: its pieces arrive on their own). */
  selfFades?: boolean;
}

/** A frame animated by its own code once mounted (chapters 4 and 5), ticked with the rest. */
export interface LiveFrame {
  update(p: number): void;
  tick(dt: number): void;
}
