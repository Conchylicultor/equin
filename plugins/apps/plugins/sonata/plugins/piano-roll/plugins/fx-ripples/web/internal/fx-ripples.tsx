/**
 * fx-ripples — expanding sound-wave rings from each note strike.
 *
 * One pooled additive ring sprite per ripple, spawned at (x center, laneY) in
 * the BELOW-notes layer (the falling bars stay readable over it), scale
 * easing out while alpha decays over ~700 ms. The canvas clips at the lane
 * bottom, so the ring reads as a half-ripple radiating from the keyboard line.
 *
 * CHORD MERGE: onsets within one frame are buffered and flushed by the frame updater
 * as a SINGLE ripple at the velocity-weighted center, with strength growing
 * ~√count — a chord reads as one stronger wave instead of N overlapping rings
 * (which would bloom into mud under additive blending). Costs at most one
 * frame (~16 ms) of latency, imperceptible at ripple timescales.
 *
 * Headless: imperative Pixi wired in one effect with full teardown.
 */
import { useEffect } from "react";
import { Graphics, type Renderer, type Texture } from "pixi.js";
import {
  easeOutCubic,
  type FxContext,
} from "@plugins/apps/plugins/sonata/plugins/piano-roll/web";

/** Ring expansion lifetime. */
const RIPPLE_LIFE_SEC = 0.7;

/** Thin ring with a faint inner echo — reads as a sound wave, not a donut. */
function makeRingTexture(renderer: Renderer): Texture {
  const g = new Graphics();
  const C = 48;
  g.circle(C, C, 44).stroke({ width: 5, color: 0xffffff, alpha: 1 });
  g.circle(C, C, 37).stroke({ width: 2, color: 0xffffff, alpha: 0.35 });
  const tex = renderer.generateTexture({ target: g, antialias: true });
  g.destroy();
  return tex;
}

export function SoundWaveRipplesFx({ fx }: { fx: FxContext }) {
  useEffect(() => {
    const ringTex = makeRingTexture(fx.renderer);
    const rings = fx.createEmitter(fx.layers.belowNotes, {
      texture: ringTex,
      capacity: Math.min(24, fx.quality.particleBudget),
      ease: easeOutCubic,
    });

    // Current-frame onset accumulator (flushed by the frame updater — chord merge).
    let count = 0;
    let sumX = 0;
    let sumW = 0;
    let maxVel = 0;
    let color = 0xffffff;

    const offNoteOn = fx.onNoteOn((e) => {
      const cx = e.x + e.width / 2;
      const w = Math.max(0.05, e.velocity); // weight ~ velocity, never 0
      count++;
      sumX += cx * w;
      sumW += w;
      if (e.velocity >= maxVel) {
        maxVel = e.velocity;
        color = e.color; // the loudest note of the chord tints the wave
      }
    });

    const offReset = fx.onReset(() => {
      count = 0;
      sumX = 0;
      sumW = 0;
      maxVel = 0;
      rings.clear();
    });

    const tick = (dt: number): boolean => {
      if (count > 0) {
        // Strength: √count caps chord stacking; velocity sets the base.
        const strength = Math.min(1.6, Math.sqrt(count)) * (0.5 + 0.5 * maxVel);
        const x = sumX / sumW;
        const laneY = fx.getLaneSize().height;
        rings.spawn(1, () => ({
          x,
          y: laneY,
          lifeSec: RIPPLE_LIFE_SEC,
          scaleFrom: 0.15,
          scaleTo: 1 + 0.8 * strength,
          alphaFrom: Math.min(0.5, 0.18 + 0.22 * strength),
          alphaTo: 0,
          tint: color,
        }));
        count = 0;
        sumX = 0;
        sumW = 0;
        maxVel = 0;
      }
      rings.update(dt);
      return rings.liveCount() > 0;
    };
    const offFrame = fx.onFrame(tick);

    return () => {
      offNoteOn();
      offReset();
      offFrame();
      rings.destroy();
      ringTex.destroy(true);
    };
  }, [fx]);

  return null;
}
