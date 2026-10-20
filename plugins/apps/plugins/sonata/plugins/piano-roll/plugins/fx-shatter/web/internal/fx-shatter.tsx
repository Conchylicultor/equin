/**
 * fx-shatter — each note-on bursts into small debris squares spread across the
 * key column at the now-line.
 *
 * Per onset, ~width/3 (clamped 4..16) particles spawn across [x, x+width] at
 * laneY, tinted the event color with ±brightness jitter so the burst reads as
 * fragments of ONE material rather than confetti. Velocities are outward
 * (proportional to distance from the column center) + upward, then gravity
 * pulls the debris down through the line — an up-and-out arc that stays
 * visible inside the lane for most of its ~900 ms fade (debris spawned moving
 * straight down would leave the clipped canvas almost immediately).
 *
 * Budget-capped via the shared pool: a dense chord run simply drops the
 * overflow spawns. Headless; full teardown in the effect cleanup.
 */
import { useEffect } from "react";
import { Graphics, type Renderer, type Texture } from "pixi.js";
import type { FxContext } from "@plugins/apps/plugins/sonata/plugins/piano-roll/web";

/** Tiny rounded shard — rounded so additive overlaps stay soft. */
function makeDebrisTexture(renderer: Renderer): Texture {
  const g = new Graphics();
  g.roundRect(0, 0, 6, 6, 1.5).fill({ color: 0xffffff, alpha: 1 });
  const tex = renderer.generateTexture({ target: g, antialias: true });
  g.destroy();
  return tex;
}

/**
 * Multiply each RGB channel by one shared random factor in [1−amount, 1+amount]
 * — a brightness (not hue) jitter, so debris stays the note's color family.
 */
function jitterBrightness(rgb: number, amount: number): number {
  const f = 1 + (Math.random() * 2 - 1) * amount;
  const ch = (v: number): number => Math.max(0, Math.min(255, Math.round(v * f)));
  return (ch((rgb >> 16) & 0xff) << 16) | (ch((rgb >> 8) & 0xff) << 8) | ch(rgb & 0xff);
}

export function NoteShatterFx({ fx }: { fx: FxContext }) {
  useEffect(() => {
    const debrisTex = makeDebrisTexture(fx.renderer);
    const debris = fx.createEmitter(fx.layers.aboveNotes, {
      texture: debrisTex,
      capacity: Math.min(600, fx.quality.particleBudget),
      gravity: 900,
      drag: 0.6,
    });

    const offNoteOn = fx.onNoteOn((e) => {
      const n = Math.min(16, Math.max(4, Math.round(e.width / 3)));
      const cx = e.x + e.width / 2;
      const halfW = Math.max(1, e.width / 2);
      debris.spawn(n, (i) => {
        // Even spread across the key column, with a little positional jitter.
        const px = e.x + ((i + 0.5) / n) * e.width + (Math.random() - 0.5) * 3;
        const outward = (px - cx) / halfW; // −1 (left edge) .. 1 (right edge)
        return {
          x: px,
          y: e.laneY,
          vx: outward * (40 + 60 * e.velocity) + (Math.random() - 0.5) * 50,
          vy: -(40 + Math.random() * 140 * (0.4 + 0.6 * e.velocity)),
          lifeSec: 0.65 + Math.random() * 0.5,
          rotation: Math.random() * Math.PI,
          spin: (Math.random() - 0.5) * 12,
          scaleFrom: 0.7 + Math.random() * 0.7,
          scaleTo: 0.4,
          alphaFrom: 0.5 + 0.35 * e.velocity,
          alphaTo: 0,
          tint: jitterBrightness(e.color, 0.25),
        };
      });
    });

    const offReset = fx.onReset(() => debris.clear());

    const offFrame = fx.onFrame((dt) => {
      debris.update(dt);
      return debris.liveCount() > 0;
    });

    return () => {
      offNoteOn();
      offReset();
      offFrame();
      debris.destroy();
      debrisTex.destroy(true);
    };
  }, [fx]);

  return null;
}
