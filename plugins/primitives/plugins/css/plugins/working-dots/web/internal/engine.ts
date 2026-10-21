import {
  clamp01,
  DOT_STYLES,
  DOT_UNITS,
  PITCH,
  REST_X,
  type DotStyleName,
} from "./shapes";

/** What the agent is doing: picks which styles the dots draw from, and how much energy. */
export type WorkingMood = "working" | "thinking" | "writing" | "tool";

const MOODS: Record<
  WorkingMood,
  { energy: number; weights: Partial<Record<DotStyleName, number>> }
> = {
  thinking: { energy: 0.25, weights: { wave: 3, glow: 3, gooey: 1 } },
  writing: { energy: 0.85, weights: { gooey: 3, wave: 2, leap: 2, glow: 1 } },
  tool: { energy: 0.55, weights: { orbit: 2, leap: 2, glow: 2, gooey: 1 } },
  working: { energy: 0.4, weights: { glow: 2, wave: 2, gooey: 1 } },
};

const BASE_MS = 2000;
/** Breath and stretch periods, deliberately incommensurate with a pass. */
const BREATH_MS = 2600;

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const easeInOut = (t: number) => 0.5 - 0.5 * Math.cos(Math.PI * clamp01(t));

/** Smooth 1-D value noise in [0, 1]: neighbouring inputs give neighbouring outputs. */
function valueNoise(): (x: number) => number {
  const lattice = Array.from({ length: 256 }, () => Math.random());
  return (x) => {
    const i = Math.floor(x);
    const f = x - i;
    const u = f * f * (3 - 2 * f);
    return lerp(lattice[i & 255]!, lattice[(i + 1) & 255]!, u);
  };
}

export interface DotsEngineTarget {
  /** The row; gets the goo filter while a gooey pass runs. */
  row: HTMLElement;
  /** The three dots, left to right at rest. */
  dots: readonly HTMLElement[];
  /** Each dot's halo layer. */
  halos: readonly HTMLElement[];
  /** CSS `filter` value of the gooey filter. */
  gooFilter: string;
}

interface Pass {
  t0: number;
  dur: number;
  amp: number;
  lags: number[];
  omega: number;
  zeta: number;
  holdMs: number;
}

interface DotState {
  p: number;
  v: number;
  prev: [number, number] | null;
  vx: number;
  vy: number;
}

/**
 * Drives the dots: one rAF loop writing transforms straight to the elements.
 * `start` / `stop` gate the loop (visibility); `setMood` retunes it live.
 */
export function createDotsEngine(
  target: DotsEngineTarget,
  initialMood: WorkingMood,
) {
  const { row, dots, halos, gooFilter } = target;
  const noise = valueNoise();
  let mood = MOODS[initialMood];
  let burst = 0;
  let style: DotStyleName | null = null;
  let repsLeft = 0;
  let passN = 0;
  let pass: Pass | null = null;
  let hold = { t0: 0, until: 0 };
  let unit = 1;
  const st: DotState[] = dots.map(() => ({
    p: 0,
    v: 0,
    prev: null,
    vx: 0,
    vy: 0,
  }));
  let raf = 0;
  let last = 0;

  function pickStyle(): DotStyleName {
    const pool = (
      Object.entries(mood.weights) as [DotStyleName, number][]
    ).filter(([n]) => n !== style);
    let r = Math.random() * pool.reduce((t, [, w]) => t + w, 0);
    for (const [n, w] of pool) if ((r -= w) <= 0) return n;
    return pool[0]![0];
  }

  function startPass(now: number) {
    if (repsLeft <= 0) {
      style = pickStyle();
      const max = DOT_STYLES[style].maxReps ?? 3;
      repsLeft = 1 + Math.floor(Math.random() * max);
      row.style.filter = DOT_STYLES[style].goo ? gooFilter : "";
    }
    repsLeft--;
    // Offsets are authored for a 6-wide dot; follow the rendered size (density).
    unit = (dots[0]?.offsetWidth ?? DOT_UNITS) / DOT_UNITS;
    const e = clamp01(mood.energy + burst);
    const n = passN++ * 0.61;
    const dur = BASE_MS * lerp(1.15, 0.92, e) * lerp(0.92, 1.08, noise(n + 11));
    const lagStep = lerp(60, 140, noise(n + 53));
    pass = {
      t0: now,
      dur,
      amp: lerp(0.85, 1, e) * lerp(0.88, 1.08, noise(n + 37)),
      lags: [0, 1, 2].map((i) => i * lagStep),
      // A touch under-damped: each dot overshoots faintly and settles.
      omega: (2 * Math.PI) / ((dur * 0.6) / 1000),
      zeta: lerp(0.86, 0.78, e),
      holdMs: lerp(900, 250, e) * lerp(0.6, 1.4, noise(n + 71)),
    };
    for (const d of st) {
      d.p = 0;
      d.v = 0;
    }
  }

  function endPass(now: number, p: Pass) {
    const ms = repsLeft > 0 ? p.holdMs * 0.35 : p.holdMs;
    pass = null;
    for (const d of st) {
      d.p = 0;
      d.v = 0;
      d.prev = null;
    }
    hold = { t0: now, until: now + ms };
  }

  function frame(now: number) {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    burst *= Math.exp(-dt / 2);
    if (!pass && now >= hold.until) startPass(now);

    if (pass) {
      const p = pass;
      const ramp = p.dur * 0.75;
      let settled = true;
      st.forEach((d, i) => {
        const tl = now - p.t0 - p.lags[i]!;
        // A spring chasing an eased target: starts from rest, settles with a faint overshoot.
        const targetP = easeInOut(tl / ramp);
        for (let k = 0; k < 4; k++) {
          const h = dt / 4;
          const acc =
            p.omega ** 2 * (targetP - d.p) - 2 * p.zeta * p.omega * d.v;
          d.v += acc * h;
          d.p += d.v * h;
        }
        if (tl < ramp || Math.abs(1 - d.p) > 0.003 || Math.abs(d.v) > 0.03)
          settled = false;
      });
      if (settled) endPass(now, p);
    }

    const pose = style ? DOT_STYLES[style].pose : null;
    const span = Math.max(1, hold.until - hold.t0);
    const holdW = pass
      ? 0
      : Math.sin(Math.PI * clamp01((now - hold.t0) / span)) ** 2;
    dots.forEach((el, i) => {
      const d = st[i]!;
      const {
        x = 0,
        y = 0,
        s: s0 = 1,
        halo = 0,
      } = pass && pose ? pose(d.p, i, pass.amp) : {};
      let s = s0;
      const px = REST_X[i]! + x;
      // Keyed to where the dot IS, not which element it is, so leap's hand-over never pops.
      const phase = px / PITCH;
      if (holdW) {
        s *=
          1 -
          0.05 *
            holdW *
            (0.5 +
              0.5 * Math.sin((2 * Math.PI * now) / BREATH_MS + phase * 1.3));
      }
      if (d.prev && dt > 0) {
        d.vx = lerp(d.vx, (px - d.prev[0]) / dt, 0.15);
        d.vy = lerp(d.vy, (y - d.prev[1]) / dt, 0.15);
      } else {
        d.vx = 0;
        d.vy = 0;
      }
      d.prev = [px, y];
      const stretch = Math.min(0.18, Math.hypot(d.vx, d.vy) / 400);
      const angle = Math.atan2(d.vy, d.vx);
      el.style.transform = `translate(${x * unit}px, ${y * unit}px) rotate(${angle}rad) scale(${s * (1 + stretch)}, ${s / Math.sqrt(1 + stretch)})`;
      const h = halos[i];
      if (h) {
        h.style.opacity = String(0.25 * halo);
        h.style.transform = `scale(${1 + 0.9 * halo})`;
      }
    });
    raf = requestAnimationFrame(frame);
  }

  return {
    start() {
      if (raf) return;
      last = performance.now();
      raf = requestAnimationFrame(frame);
    },
    stop() {
      cancelAnimationFrame(raf);
      raf = 0;
    },
    setMood(next: WorkingMood) {
      if (MOODS[next] === mood) return;
      mood = MOODS[next];
      burst = 0.2; // a change of activity lands as a short lift in energy…
      repsLeft = 0; // …and the next pass draws from the new mood
    },
  };
}
