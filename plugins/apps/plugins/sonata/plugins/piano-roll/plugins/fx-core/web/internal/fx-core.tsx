/**
 * fx-core — the ambient baseline effect set, three pieces per note-on:
 *
 *  1. KEY-STRIKE GLOW — one pooled additive sprite of a shared radial-gradient
 *     texture at the strike point (x center, laneY), tinted the event color,
 *     scaled to the key width, ~250 ms ease-out fade.
 *  2. RISING SPARKS — 3–8 (velocity-scaled) small additive particles drifting
 *     up from the strike with jitter and spread, ~600 ms fade.
 *  3. ACTIVE-NOTE BRIGHTEN — an additive white quad tinted the event color
 *     (alpha ≈ 0.18) over the portion of the sounding bar still ABOVE the
 *     now-line, shrinking as the bar scrolls past it.
 *
 * BRIGHTEN GEOMETRY — the brighten is welded to its note because it is a PURE
 * FUNCTION of the playback cursor, not an integrated wall-clock timer. The bar
 * spans beats [start, start+duration]; the now-line is the cursor, so the part
 * still above the line is `beatToY(cursor) − beatToY(start + duration)` pixels
 * — measured through the SAME projection that places the note, never as a
 * beat fraction of `rect.h`: a tempo map that changes inside the note (a song
 * timed to its recording changes tempo every beat) makes beats and pixels
 * non-proportional, and a beat fraction then shrinks the brighten faster or
 * slower than the bar scrolls. Anchored bottom-at-laneY (`rect` and `beatToY`
 * come fresh from `getProjection()` each tick, so resizes and zoom stay
 * pixel-exact). Reading `fx.getPlaybackBeats()` rather than accumulating
 * frame deltas is what guarantees the highlight stays on the note when
 * playback isn't advancing at real time: PAUSED ⇒ frozen cursor ⇒ frozen
 * highlight on the frozen bar; SCRUB ⇒ it tracks the bar both ways. It is also
 * tempo-exact by construction (beats, not seconds), so a tempo-map or live
 * tempo-scale change mid-note no longer drifts. Every seek still clears
 * in-flight bars via onReset (navigation must not leave a stale highlight).
 *
 * Headless: renders nothing; all painting is imperative Pixi wired in one
 * effect with full teardown (unsubscribe, unregister the frame updater, destroy containers
 * and generated textures).
 */
import { useEffect } from "react";
import { Container, Graphics, Sprite, Texture, type Renderer } from "pixi.js";
import {
  easeOutCubic,
  type FxContext,
  type FxNoteEvent,
} from "@plugins/apps/plugins/sonata/plugins/piano-roll/web";

/** Brighten quad base alpha (additive, so it reads as a gentle lift). */
const BRIGHTEN_ALPHA = 0.18;
/** Fade-out window at the end of a brighten (avoids a visible pop). */
const BRIGHTEN_RELEASE_SEC = 0.12;
/** Bars shorter than this aren't worth a brighten (grace-note spam guard). */
const BRIGHTEN_MIN_SEC = 0.05;
/** Hard cap on simultaneous brighten quads (dense chords degrade gracefully). */
const BRIGHTEN_MAX_LIVE = 64;

/**
 * Soft radial glow: stacked concentric discs of low constant alpha approximate
 * a Gaussian falloff (alpha accumulates toward the center). Generated once per
 * mount; the caller owns (and must destroy) the texture.
 */
function makeGlowTexture(renderer: Renderer): Texture {
  const g = new Graphics();
  const R = 32;
  const STEPS = 16;
  for (let s = 0; s < STEPS; s++) {
    g.circle(R, R, R * (1 - s / STEPS)).fill({ color: 0xffffff, alpha: 0.1 });
  }
  const tex = renderer.generateTexture({ target: g, antialias: true });
  g.destroy();
  return tex;
}

/** Small soft dot for sparks: bright core + faint halo. */
function makeSparkTexture(renderer: Renderer): Texture {
  const g = new Graphics();
  g.circle(4, 4, 3.5).fill({ color: 0xffffff, alpha: 0.35 });
  g.circle(4, 4, 2).fill({ color: 0xffffff, alpha: 1 });
  const tex = renderer.generateTexture({ target: g, antialias: true });
  g.destroy();
  return tex;
}

interface LiveBar {
  note: FxNoteEvent["note"];
  /** Wall-clock duration at onset — only sizes the end-of-note release fade. */
  dur: number;
  sprite: Sprite;
}

export function NoteGlowSparksFx({ fx }: { fx: FxContext }) {
  useEffect(() => {
    const glowTex = makeGlowTexture(fx.renderer);
    const sparkTex = makeSparkTexture(fx.renderer);
    const budget = fx.quality.particleBudget;

    const glow = fx.createEmitter(fx.layers.aboveNotes, {
      texture: glowTex,
      capacity: Math.min(48, budget),
      ease: easeOutCubic,
    });
    const sparks = fx.createEmitter(fx.layers.aboveNotes, {
      texture: sparkTex,
      capacity: Math.min(320, budget),
      // Gentle deceleration so sparks drift to a stop rather than flying off.
      gravity: 40,
      drag: 0.8,
    });

    // --- brighten quads: a visible/invisible sprite pool over Texture.WHITE --
    const brightenLayer = new Container();
    fx.layers.aboveNotes.addChild(brightenLayer);
    const freeSprites: Sprite[] = [];
    const liveBars: LiveBar[] = [];
    const acquireSprite = (): Sprite => {
      const s = freeSprites.pop() ?? new Sprite(Texture.WHITE);
      if (!s.parent) {
        s.blendMode = "add";
        brightenLayer.addChild(s);
      }
      s.visible = true;
      return s;
    };
    const releaseSprite = (s: Sprite): void => {
      s.visible = false;
      freeSprites.push(s);
    };

    const offNoteOn = fx.onNoteOn((e) => {
      const cx = e.x + e.width / 2;

      // 1. Glow: diameter ≈ 2.4× the key width, alpha scaled by velocity.
      const glowScale = (e.width * 2.4) / glowTex.width;
      glow.spawn(1, () => ({
        x: cx,
        y: e.laneY,
        lifeSec: 0.25,
        scaleFrom: glowScale,
        scaleTo: glowScale * 1.35,
        alphaFrom: 0.18 + 0.32 * e.velocity,
        alphaTo: 0,
        tint: e.color,
      }));

      // 2. Sparks: 3–8 by velocity, rising with jitter and slight spread.
      const n = 3 + Math.round(e.velocity * 5);
      sparks.spawn(n, () => ({
        x: cx + (Math.random() - 0.5) * e.width * 0.8,
        y: e.laneY,
        vx: (Math.random() - 0.5) * 60,
        vy: -(50 + Math.random() * 90 + e.velocity * 90),
        lifeSec: 0.45 + Math.random() * 0.3,
        scaleFrom: 0.7 + Math.random() * 0.5,
        scaleTo: 0.25,
        alphaFrom: 0.5 + 0.4 * e.velocity,
        alphaTo: 0,
        tint: e.color,
      }));

      // 3. Brighten: track the sounding bar (see header for the geometry).
      if (
        e.durationSeconds > BRIGHTEN_MIN_SEC &&
        liveBars.length < BRIGHTEN_MAX_LIVE
      ) {
        const sprite = acquireSprite();
        sprite.tint = e.color;
        sprite.alpha = BRIGHTEN_ALPHA;
        liveBars.push({ note: e.note, dur: e.durationSeconds, sprite });
      }
    });

    const offReset = fx.onReset(() => {
      // Seek/score-change: every in-flight visual is stale — drop it all.
      for (const bar of liveBars) releaseSprite(bar.sprite);
      liveBars.length = 0;
      glow.clear();
      sparks.clear();
    });

    const tick = (dt: number): boolean => {
      glow.update(dt);
      sparks.update(dt);
      // Only the emitters animate on their own. The brighten bars are a pure
      // function of the cursor (re-evaluated on every cursor change, which
      // wakes a frame), so a paused cursor with live bars must NOT hold the
      // loop open.
      const animating = glow.liveCount() > 0 || sparks.liveCount() > 0;
      if (liveBars.length === 0) return animating;
      const proj = fx.getProjection();
      // `noteToRect` / `beatToY` are optional on Projection (capability-
      // dependent), but the piano roll always publishes a time-axis +
      // pitch-plane projection — fail loudly if that invariant ever breaks
      // rather than silently skipping the effect.
      const { noteToRect, beatToY } = proj;
      if (!noteToRect || !beatToY) {
        throw new Error(
          "fx-core: projection lacks noteToRect/beatToY (time-axis + pitch-plane capabilities expected)",
        );
      }
      const laneY = fx.getLaneSize().height;
      // The playback cursor drives the brighten (NOT integrated wall-clock), so
      // the highlight is glued to the bar on pause/scrub — see header geometry.
      const nowY = beatToY(fx.getPlaybackBeats());
      for (let i = liveBars.length - 1; i >= 0; i--) {
        const bar = liveBars[i]!;
        // Fresh rect per tick → resize/zoom-proof.
        const rect = noteToRect(bar.note);
        // The pitch is not on this axis (a layout may not carry it) — there is
        // nowhere honest to paint, so skip this bar rather than invent a box.
        if (!rect) continue;
        // Pixels of the bar still above the now-line: content-space distance
        // from the cursor up to the note's top edge (rect.y = its end). Same
        // mapping as the note itself, so it is exact under any tempo map.
        const remainingPx = nowY - rect.y;
        if (remainingPx <= 0 || rect.h <= 0) {
          releaseSprite(bar.sprite);
          liveBars.splice(i, 1);
          continue;
        }
        const h = Math.min(rect.h, remainingPx);
        const s = bar.sprite;
        s.position.set(rect.x, laneY - h);
        s.width = rect.w;
        s.height = h;
        // Release fade over the note's final BRIGHTEN_RELEASE_SEC of wall-clock,
        // derived from the same cursor-driven remaining fraction.
        const remainingSec = (h / rect.h) * bar.dur;
        s.alpha =
          BRIGHTEN_ALPHA * Math.min(1, remainingSec / BRIGHTEN_RELEASE_SEC);
      }
      return animating;
    };
    const offFrame = fx.onFrame(tick);

    return () => {
      offNoteOn();
      offReset();
      offFrame();
      glow.destroy();
      sparks.destroy();
      // Destroys pooled sprites too; Texture.WHITE is shared and untouched
      // (sprite destroy does not destroy textures by default).
      brightenLayer.destroy({ children: true });
      glowTex.destroy(true);
      sparkTex.destroy(true);
    };
  }, [fx]);

  return null;
}
