import { noise3, smoothstep } from "./noise";

/** Strand spacing, px. */
const GAP = 20;
/** Noise time units per second: how fast the resting flow turns. */
const DRIFT = 0.048;
/** Live magnets at once; the oldest goes first. */
const MAX_MAGNETS = 5;
/** Alpha of the brightest strand. Barely there by design. */
const PEAK_ALPHA = 0.1;
/** Brightness levels strands are batched into, so a frame is a few paths. */
const LEVELS = 6;
/** A pointer movement after this long a pause starts a new stroke. */
const STROKE_GAP_MS = 350;

const jitter = (a: number, b: number) => a + Math.random() * (b - a);

/** The resting flow's direction at a point: a slowly turning angle. */
const flowAngle = (x: number, y: number, t: number) =>
  noise3(x * 0.0028, y * 0.0028, t) * Math.PI * 4;

interface Strand {
  x: number;
  y: number;
  /** Current angle; strands have no head, so it is read modulo π. */
  angle: number;
  /** How quickly this strand turns toward the field (strands differ). */
  rate: number;
  length: number;
}

/**
 * A stroke's magnet: a pole (strands point to it, or away) or a vortex
 * (strands circle it), of its own strength and reach. It glides after the
 * pointer while its stroke lasts, swells in, and ebbs away once let go.
 */
interface Magnet {
  kind: "pole" | "vortex";
  sign: 1 | -1;
  strength: number;
  reach: number;
  x: number;
  y: number;
  targetX: number;
  targetY: number;
  age: number;
  sinceTouch: number;
  fade: number;
  envelope: number;
}

export interface FilingsField {
  /** The drawing surface changed size (CSS px), or what it recedes behind moved. */
  resize(width: number, height: number, recede: Recede | null): void;
  /** A pointer movement at (x, y), CSS px within the surface, at `now` ms. */
  pointer(x: number, y: number, now: number): void;
  /** The pointer left the surface. */
  release(): void;
  /** Advance by `dt` seconds and draw. `color` is any CSS colour. */
  frame(
    ctx: CanvasRenderingContext2D,
    dt: number,
    now: number,
    color: string,
  ): void;
}

/** A horizontal band (CSS px) the field recedes behind, so text over it stays clean. */
export interface Recede {
  left: number;
  right: number;
}

export function createFilingsField(): FilingsField {
  let width = 0;
  let height = 0;
  let recede: Recede | null = null;
  let strands: Strand[] = [];
  const magnets: Magnet[] = [];
  let held: Magnet | null = null;
  let lastPointerAt = -Infinity;
  const buckets: number[][] = Array.from({ length: LEVELS }, () => []);

  // 1 in the open, 0.4 well inside the receding band, eased across its edge.
  const openness = (x: number) =>
    recede
      ? 1 -
        0.6 * smoothstep(-60, 40, Math.min(x - recede.left, recede.right - x))
      : 1;

  return {
    resize(w, h, r) {
      recede = r;
      if (w === width && h === height) return;
      width = w;
      height = h;
      strands = [];
      for (let y = GAP / 2; y < h; y += GAP)
        for (let x = GAP / 2; x < w; x += GAP)
          strands.push({
            x: x + jitter(-5, 5),
            y: y + jitter(-5, 5),
            angle: flowAngle(x, y, 0),
            rate: jitter(0.8, 2.4),
            length: jitter(5, 9),
          });
    },

    pointer(x, y, now) {
      // Each stroke wakes a magnet of a random kind; the system answers every
      // touch, never quite the same way twice.
      if (held === null || now - lastPointerAt > STROKE_GAP_MS) {
        held = {
          kind: Math.random() < 0.55 ? "pole" : "vortex",
          sign: Math.random() < 0.5 ? -1 : 1,
          strength: jitter(0.8, 2.2),
          reach: jitter(110, 220),
          x,
          y,
          targetX: x,
          targetY: y,
          age: 0,
          sinceTouch: 0,
          fade: jitter(2, 5),
          envelope: 0,
        };
        magnets.push(held);
        if (magnets.length > MAX_MAGNETS) magnets.shift();
      }
      held.targetX = x;
      held.targetY = y;
      held.sinceTouch = 0;
      lastPointerAt = now;
    },

    release() {
      held = null;
    },

    frame(ctx, dt, now, color) {
      const t = (now / 1000) * DRIFT;
      const follow = 1 - Math.pow(0.1, dt);
      for (let k = magnets.length - 1; k >= 0; k--) {
        const m = magnets[k]!;
        m.age += dt;
        m.sinceTouch += dt;
        if (m.sinceTouch > m.fade) {
          magnets.splice(k, 1);
          if (m === held) held = null;
          continue;
        }
        m.x += (m.targetX - m.x) * follow;
        m.y += (m.targetY - m.y) * follow;
        m.envelope =
          smoothstep(0, 0.9, m.age) *
          (1 - smoothstep(0.3, m.fade, m.sinceTouch));
      }

      for (const s of strands) {
        const f = flowAngle(s.x, s.y, t * 0.4);
        let vx = Math.cos(f);
        let vy = Math.sin(f);
        let pull = 0;
        for (const m of magnets) {
          const dx = s.x - m.x,
            dy = s.y - m.y,
            d = Math.hypot(dx, dy) + 1;
          const w =
            m.envelope * m.strength * Math.exp(-(d * d) / (m.reach * m.reach));
          pull += w;
          if (m.kind === "pole") {
            vx += (dx / d) * w * m.sign;
            vy += (dy / d) * w * m.sign;
          } else {
            vx += (-dy / d) * w * m.sign;
            vy += (dx / d) * w * m.sign;
          }
        }
        // Turn the short way round, modulo half a turn.
        let diff = Math.atan2(vy, vx) - s.angle;
        diff = (((diff % Math.PI) + Math.PI * 1.5) % Math.PI) - Math.PI / 2;
        s.angle += diff * (1 - Math.pow(0.05, dt * s.rate));

        const stirred = Math.min(1, pull);
        const len = s.length * (1 + stirred * 0.35);
        const cx = (Math.cos(s.angle) * len) / 2,
          cy = (Math.sin(s.angle) * len) / 2;
        const level = Math.min(
          LEVELS - 1,
          Math.floor((0.55 + stirred * 0.45) * openness(s.x) * LEVELS),
        );
        buckets[level]!.push(s.x - cx, s.y - cy, s.x + cx, s.y + cy);
      }

      ctx.clearRect(0, 0, width, height);
      ctx.strokeStyle = color;
      ctx.lineWidth = 0.75;
      buckets.forEach((segs, level) => {
        if (segs.length === 0) return;
        ctx.globalAlpha = (PEAK_ALPHA * (level + 0.5)) / LEVELS;
        ctx.beginPath();
        for (let i = 0; i < segs.length; i += 4) {
          ctx.moveTo(segs[i]!, segs[i + 1]!);
          ctx.lineTo(segs[i + 2]!, segs[i + 3]!);
        }
        ctx.stroke();
        segs.length = 0;
      });
      ctx.globalAlpha = 1;
    },
  };
}
