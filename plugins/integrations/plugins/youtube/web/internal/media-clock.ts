import { createSmoothClockModel } from "@plugins/packages/plugins/smooth-clock/core";
import type { YouTubePlayerController } from "./controller";

/** A smooth reading of a player's media time, for something slaved to it. */
export interface MediaClock {
  /**
   * The media time in seconds, smoothed (see `createSmoothClockModel`), or
   * `null` while the video is not advancing (paused, cued, buffering, seeking,
   * not ready). Pull-based: each call reads the player once, so call it at the
   * cadence you render or schedule at — no timer runs behind it.
   */
  position(): number | null;
}

/**
 * A {@link MediaClock} over `controller`'s playhead. The controller's own
 * `getCurrentTime()` steps whenever the iframe posts a new time; this clock
 * slews toward each step instead (at most 5 % of the rate) and snaps only on a
 * jump past 150 ms (a seek). Every stop — a pause, a stall — forgets the fit,
 * so playback resumes from the player's own reading.
 */
export function createMediaClock(
  controller: YouTubePlayerController,
): MediaClock {
  const model = createSmoothClockModel();
  return {
    position() {
      if (!controller.isAdvancing) {
        model.reset();
        return null;
      }
      const now = performance.now();
      model.observe(
        controller.getCurrentTime(),
        now,
        controller.getPlaybackRate(),
      );
      return model.at(now);
    },
  };
}
