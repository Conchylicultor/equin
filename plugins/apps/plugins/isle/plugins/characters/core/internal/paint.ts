// Painting one pose, and the ground shadow.

import type { Ctx2D } from "@plugins/apps/plugins/isle/plugins/buildings/core";
import { TAU } from "./draw-parts";
import { figure } from "./figure";
import type { FigurePose } from "./gait";
import { IDLE_FRAMES, WALK_FRAMES, type CharacterPose } from "./frame";
import { LOOKS } from "./looks";

/**
 * Paints one pose with the feet at the origin, in world px (the prototype's
 * sprite minus its SC× transform — the caller scales and translates). The
 * mirror for a left-facing side view is the caller's.
 */
export function paintCharacterPose(g: Ctx2D, pose: CharacterPose): void {
  const figurePose: FigurePose =
    pose.mode === "walk"
      ? { mode: "walk", p: pose.frame / WALK_FRAMES, blink: false, gaze: 0 }
      : {
          mode: "idle",
          b: pose.frame / IDLE_FRAMES,
          blink: pose.blink,
          gaze: pose.gaze,
        };
  figure(g, LOOKS[pose.look], pose.view, figurePose);
}

/** The soft ground shadow under a look, feet at the origin (drawn in the world, not in the sprite). */
export function paintCharacterShadow(g: Ctx2D, look: keyof typeof LOOKS): void {
  const w = LOOKS[look].w;
  g.save();
  g.fillStyle = "rgba(30,34,24,.28)";
  g.beginPath();
  g.ellipse(1.2, 0.4, 8 * w, 2.6, 0, 0, TAU);
  g.fill();
  g.fillStyle = "rgba(30,34,24,.18)";
  g.beginPath();
  g.ellipse(1.2, 0.4, 5 * w, 1.6, 0, 0, TAU);
  g.fill();
  g.restore();
}
