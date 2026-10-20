/**
 * fx-comets — melodic-motion comets along the keyboard line.
 *
 * Each track remembers its last onset (x center + a local wall-clock stamp).
 * When the SAME track fires again within ~3 s, a comet head flies from the
 * previous strike point to the new one over ~400 ms, following a quadratic
 * arc whose peak height grows with the horizontal distance (capped), while a
 * particle trail fades behind it — the melody's contour becomes a visible
 * path. Gaps over 3 s (or any seek, via onReset) clear the memory so phrase
 * boundaries and jumps never draw a meaningless streak.
 *
 * ARC: horizontal travel uses smoothstep easing (gentle launch/landing);
 * vertical lift is the parabola `4·peak·p(1−p)` on the eased progress, which
 * starts and ends exactly on the now-line. The comet launches AT the new
 * note's onset and lands ~400 ms after it — a deliberate trailing read (the
 * eye follows the just-played interval), per the plan.
 *
 * Heads are pooled sprites animated manually (a scripted path doesn't fit the
 * ballistic particle sim); the trail rides the shared budget-capped emitter.
 */
import { useEffect } from "react";
import {
  Container,
  Graphics,
  Sprite,
  type Renderer,
  type Texture,
} from "pixi.js";
import type { FxContext } from "@plugins/apps/plugins/sonata/plugins/piano-roll/web";

/** Comet flight time. */
const COMET_DUR_SEC = 0.4;
/** Same-track gaps longer than this don't read as a phrase — skip the comet. */
const MAX_GAP_SEC = 3;
/** Same-tick chord re-fires (gap ≈ 0) would draw intra-chord streaks — skip. */
const MIN_GAP_SEC = 0.05;
/** Pixels of horizontal travel below which an arc isn't worth drawing. */
const MIN_TRAVEL_PX = 6;
/** Simultaneous comet cap — dense polyphony degrades to the newest arcs. */
const MAX_LIVE_COMETS = 12;

/** Soft radial glow for the comet head (stacked-disc falloff). */
function makeHeadTexture(renderer: Renderer): Texture {
  const g = new Graphics();
  const R = 24;
  const STEPS = 12;
  for (let s = 0; s < STEPS; s++) {
    g.circle(R, R, R * (1 - s / STEPS)).fill({ color: 0xffffff, alpha: 0.12 });
  }
  const tex = renderer.generateTexture({ target: g, antialias: true });
  g.destroy();
  return tex;
}

/** Small soft dot for the trail. */
function makeTrailTexture(renderer: Renderer): Texture {
  const g = new Graphics();
  g.circle(4, 4, 3.5).fill({ color: 0xffffff, alpha: 0.4 });
  g.circle(4, 4, 2).fill({ color: 0xffffff, alpha: 1 });
  const tex = renderer.generateTexture({ target: g, antialias: true });
  g.destroy();
  return tex;
}

interface Comet {
  x0: number;
  x1: number;
  /** Arc peak height in px (∝ |x1−x0|, capped). */
  peak: number;
  /** Elapsed flight time. */
  t: number;
  color: number;
  sprite: Sprite;
}

export function PitchCometsFx({ fx }: { fx: FxContext }) {
  useEffect(() => {
    const headTex = makeHeadTexture(fx.renderer);
    const trailTex = makeTrailTexture(fx.renderer);

    const heads = new Container();
    fx.layers.aboveNotes.addChild(heads);
    const trail = fx.createEmitter(fx.layers.aboveNotes, {
      texture: trailTex,
      capacity: Math.min(240, fx.quality.particleBudget),
      drag: 1.5,
    });

    const freeHeads: Sprite[] = [];
    const comets: Comet[] = [];
    /** trackId → last onset (x center, local-clock stamp). */
    const memory = new Map<string, { x: number; at: number }>();
    /** Local wall clock, accumulated from frame deltas (advances only while frames run) (no Date.now drift). */
    let clock = 0;

    const acquireHead = (): Sprite => {
      const s = freeHeads.pop() ?? new Sprite(headTex);
      if (!s.parent) {
        s.anchor.set(0.5);
        s.blendMode = "add";
        heads.addChild(s);
      }
      s.visible = true;
      return s;
    };
    const releaseHead = (s: Sprite): void => {
      s.visible = false;
      freeHeads.push(s);
    };

    const offNoteOn = fx.onNoteOn((e) => {
      const cx = e.x + e.width / 2;
      const prev = memory.get(e.note.track);
      memory.set(e.note.track, { x: cx, at: clock });
      if (!prev) return;
      const gap = clock - prev.at;
      if (gap > MAX_GAP_SEC || gap < MIN_GAP_SEC) return;
      const dx = cx - prev.x;
      if (Math.abs(dx) < MIN_TRAVEL_PX) return; // repeated note — no path
      if (comets.length >= MAX_LIVE_COMETS) return;

      const sprite = acquireHead();
      sprite.tint = e.color;
      sprite.alpha = 0.55;
      const scale = 0.35 + 0.25 * e.velocity;
      sprite.scale.set(scale);
      comets.push({
        x0: prev.x,
        x1: cx,
        peak: Math.min(120, Math.max(20, Math.abs(dx) * 0.35)),
        t: 0,
        color: e.color,
        sprite,
      });
    });

    const offReset = fx.onReset(() => {
      // Seek/score-change: stale phrase memory must not bridge the jump.
      memory.clear();
      for (const c of comets) releaseHead(c.sprite);
      comets.length = 0;
      trail.clear();
    });

    const tick = (dt: number): boolean => {
      clock += dt;

      if (comets.length > 0) {
        const laneY = fx.getLaneSize().height;
        for (let i = comets.length - 1; i >= 0; i--) {
          const c = comets[i]!;
          c.t += dt;
          const p = Math.min(1, c.t / COMET_DUR_SEC);
          const pe = p * p * (3 - 2 * p); // smoothstep launch/landing
          const x = c.x0 + (c.x1 - c.x0) * pe;
          const y = laneY - 4 * c.peak * pe * (1 - pe);
          c.sprite.position.set(x, y);
          // Trail: a couple of faint dots dropped at the head each frame.
          trail.spawn(2, () => ({
            x: x + (Math.random() - 0.5) * 3,
            y: y + (Math.random() - 0.5) * 3,
            vx: (Math.random() - 0.5) * 15,
            vy: (Math.random() - 0.5) * 15,
            lifeSec: 0.3 + Math.random() * 0.15,
            scaleFrom: 0.9,
            scaleTo: 0.2,
            alphaFrom: 0.35,
            alphaTo: 0,
            tint: c.color,
          }));
          if (p >= 1) {
            releaseHead(c.sprite);
            comets.splice(i, 1);
          }
        }
      }
      trail.update(dt);
      return comets.length > 0 || trail.liveCount() > 0;
    };
    const offFrame = fx.onFrame(tick);

    return () => {
      offNoteOn();
      offReset();
      offFrame();
      trail.destroy();
      // Destroys pooled head sprites; the textures are ours to free.
      heads.destroy({ children: true });
      headTex.destroy(true);
      trailTex.destroy(true);
    };
  }, [fx]);

  return null;
}
