import {
  clamp01,
  DOT_STYLES,
  DOT_UNITS,
  PITCH,
  REST_X,
  type DotPose,
  type DotStyleName,
} from "./shapes";
import {
  pickReaction,
  REACTIONS,
  type Away,
  type Kick,
  type ReactionName,
} from "./reactions";

/** How lively the motion is (speed, amplitude, hold length), 0 calm → 1 lively. */
const ENERGY = 0.5;
const STYLE_NAMES = Object.keys(DOT_STYLES) as DotStyleName[];

const BASE_MS = 2000;
/** Breath and stretch periods, deliberately incommensurate with a pass. */
const BREATH_MS = 2600;
/** A dot's centre below the box's top edge, in shape units (CSS: top 2/3 dot, plus half a dot). */
const DOT_CENTRE_Y = 7;
/** The jolt spring (pokes, cut-short passes): loose, so it jiggles before it settles. */
const JOLT_OMEGA = (2 * Math.PI) / 0.5;
/** The sniff spring: softer, for the reach toward the pointer and the press huddle. */
const LEAN_OMEGA = (2 * Math.PI) / 0.75;

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

/** One damped spring step toward `target`, in four substeps. */
function spring(
  x: number,
  v: number,
  target: number,
  omega: number,
  zeta: number,
  dt: number,
): [number, number] {
  for (let k = 0; k < 4; k++) {
    const h = dt / 4;
    v += (omega ** 2 * (target - x) - 2 * zeta * omega * v) * h;
    x += v * h;
  }
  return [x, v];
}

export interface DotsEngineTarget {
  /** The box the dots rest in (unscaled): pointer positions are measured against it. */
  box: HTMLElement;
  /** The three dots, left to right at rest (drawn through the goo filter). */
  dots: readonly HTMLElement[];
  /** Each dot's halo, on its own unfiltered layer under the dots. */
  halos: readonly HTMLElement[];
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
  /** The pass's progress, carried by the pass spring. */
  p: number;
  v: number;
  /** Where the dot was drawn last frame (shape units from the box's first rest slot), and its velocity. */
  prev: [number, number] | null;
  vx: number;
  vy: number;
  /** The jolt spring's offset (x, y, scale) and velocity. */
  jx: number;
  jy: number;
  js: number;
  jvx: number;
  jvy: number;
  jvs: number;
  /** The lean spring (sniff, press huddle). */
  lx: number;
  ly: number;
  lvx: number;
  lvy: number;
}

/**
 * Drives the dots: one rAF loop writing transforms straight to the elements.
 * `start` / `stop` gate the loop (visibility); `destroy` also drops the
 * pointer listeners.
 */
export function createDotsEngine(target: DotsEngineTarget) {
  const { box, dots, halos } = target;
  const noise = valueNoise();
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
    jx: 0,
    jy: 0,
    js: 0,
    jvx: 0,
    jvy: 0,
    jvs: 0,
    lx: 0,
    ly: 0,
    lvx: 0,
    lvy: 0,
  }));
  /** Each dot's pose last frame, handed to its jolt spring when a poke cuts the pass short. */
  let poses: Required<Omit<DotPose, "halo">>[] = dots.map(() => ({
    x: 0,
    y: 0,
    s: 1,
  }));
  let raf = 0;
  let last = 0;

  // The pointer, in shape units relative to the first dot's rest centre; null when unknown.
  let ptr: { x: number; y: number } | null = null;
  let ptrClient: { x: number; y: number } | null = null;
  let ptrMovedAt = 0;
  /** How much the row is minding the pointer (sniff), 0..1, taken up with a delay. */
  let attn = 0;
  /** What pokes leave behind, decaying: faster, bigger, glowing. */
  let excite = 0;
  let squash = 0;
  let pressed = false;
  let lastReaction: ReactionName | null = null;
  const kicks: (Kick & { due: number })[] = [];

  const measureUnit = () => {
    unit = (dots[0]?.offsetWidth || DOT_UNITS) / DOT_UNITS;
  };
  function locatePointer() {
    if (!ptrClient) return;
    const r = box.getBoundingClientRect();
    ptr = {
      x: (ptrClient.x - r.left) / unit - DOT_UNITS / 2,
      y: (ptrClient.y - r.top) / unit - DOT_CENTRE_Y,
    };
  }

  /** Any style but the current one, uniformly. */
  function pickStyle(): DotStyleName {
    const pool = STYLE_NAMES.filter((n) => n !== style);
    return pool[Math.floor(Math.random() * pool.length)]!;
  }

  function startPass(now: number, forced?: DotStyleName) {
    if (forced) {
      style = forced;
      repsLeft = 0;
    } else {
      if (repsLeft <= 0) {
        style = pickStyle();
        const max = DOT_STYLES[style].maxReps ?? 3;
        repsLeft = 1 + Math.floor(Math.random() * max);
      }
      repsLeft--;
    }
    // Offsets are authored for a 6-wide dot; follow the rendered size (density).
    measureUnit();
    const ex = clamp01(excite);
    const e = clamp01(ENERGY + 0.5 * excite);
    const n = passN++ * 0.61;
    const dur =
      BASE_MS *
      lerp(1.15, 0.92, e) *
      lerp(0.92, 1.08, noise(n + 11)) *
      lerp(1, 0.68, ex);
    const lagStep = lerp(60, 140, noise(n + 53));
    pass = {
      t0: now,
      dur,
      amp: lerp(0.85, 1, e) * lerp(0.88, 1.08, noise(n + 37)),
      lags: [0, 1, 2].map((i) => i * lagStep),
      // A touch under-damped: each dot overshoots faintly and settles.
      omega: (2 * Math.PI) / ((dur * 0.6) / 1000),
      zeta: lerp(0.86, 0.78, e),
      holdMs:
        lerp(900, 250, e) * lerp(0.6, 1.4, noise(n + 71)) * (1 - 0.8 * ex),
    };
    for (const d of st) {
      d.p = 0;
      d.v = 0;
    }
  }

  function endPass(now: number, p: Pass, ended: DotStyleName) {
    // leap ends with the dots having traded places: hand each dot's own motion (jolt, lean,
    // velocity) to the element now standing where it stood, so nothing pops at the seam.
    const slots = REST_X.map((rest, i) =>
      Math.round((rest + (DOT_STYLES[ended].pose(1, i, p.amp).x ?? 0)) / PITCH),
    );
    if (new Set(slots).size === st.length) {
      const moved = [...st];
      slots.forEach((j, i) => {
        st[j] = moved[i]!;
      });
    }
    const ms = repsLeft > 0 ? p.holdMs * 0.35 : p.holdMs;
    pass = null;
    for (const d of st) {
      d.p = 0;
      d.v = 0;
    }
    hold = { t0: now, until: now + ms };
  }

  /** Cut the pass short without a seam: each dot's pose goes to its jolt spring, which carries it home. */
  function interrupt(now: number, next: DotStyleName) {
    st.forEach((d, i) => {
      const q = poses[i]!;
      d.jx += q.x;
      d.jy += q.y;
      d.js += q.s - 1;
    });
    pass = null;
    startPass(now, next);
  }

  function poke(clientX: number, clientY: number) {
    const now = performance.now();
    const name = (lastReaction = pickReaction(lastReaction));
    const reaction = REACTIONS[name];
    excite = Math.min(1.6, excite + 0.5);
    interrupt(now, reaction.ring ? "ring" : pickStyle());
    ptrClient = { x: clientX, y: clientY };
    locatePointer();
    const at = ptr ?? { x: REST_X[1], y: 0 };
    let hit = 0;
    let best = Infinity;
    // Each dot's way out, away from the finger; a dot poked dead centre picks a way out upward.
    const away: Away = st.map((d, i) => {
      const [x, y] = d.prev ?? [REST_X[i]!, 0];
      const dx = x - at.x;
      const dy = y - at.y;
      const len = Math.hypot(dx, dy);
      if (len < best) {
        best = len;
        hit = i;
      }
      if (len < 1.5) {
        const a = -Math.PI / 2 + (Math.random() - 0.5) * 1.6;
        return [Math.cos(a), Math.sin(a)] as const;
      }
      return [dx / len, dy / len] as const;
    });
    const m = 0.8 + 0.4 * Math.random() + 0.3 * clamp01(excite - 0.5);
    for (const k of reaction.kicks(away, m, hit))
      kicks.push({ ...k, due: now + k.at });
  }

  // ---- the pointer ----
  const onMove = (ev: PointerEvent) => {
    ptrClient = { x: ev.clientX, y: ev.clientY };
    ptrMovedAt = performance.now();
    if (raf) locatePointer();
  };
  const onLeave = () => {
    ptrClient = null;
    ptr = null;
  };
  const onDown = (ev: PointerEvent) => {
    if (ev.button !== 0) return;
    ev.preventDefault();
    pressed = true;
    box.setPointerCapture(ev.pointerId);
  };
  const onUp = (ev: PointerEvent) => {
    if (!pressed) return;
    pressed = false;
    const r = box.getBoundingClientRect();
    const pad = 8;
    if (
      ev.clientX >= r.left - pad &&
      ev.clientX <= r.right + pad &&
      ev.clientY >= r.top - pad &&
      ev.clientY <= r.bottom + pad
    )
      poke(ev.clientX, ev.clientY);
  };
  const onCancel = () => {
    pressed = false;
  };
  window.addEventListener("pointermove", onMove, { passive: true });
  document.documentElement.addEventListener("pointerleave", onLeave);
  box.addEventListener("pointerdown", onDown);
  box.addEventListener("pointerup", onUp);
  box.addEventListener("pointercancel", onCancel);

  function frame(now: number) {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;

    // sniff: answer only a pointer right at the row (its distance to the row segment), minded
    // less the longer it sits still (the row gets used to you). The box is re-measured only
    // while the pointer is close, so a still pointer over a scrolling transcript stays true.
    const rowDist = ptr
      ? Math.hypot(Math.max(0, Math.abs(ptr.x - REST_X[1]) - PITCH), ptr.y)
      : Infinity;
    if (rowDist < 40) locatePointer();
    const near =
      1 - easeInOut((rowDist * unit - 4 * unit - 4) / (8 * unit + 6));
    const habit = clamp01((now - ptrMovedAt - 1500) / 3000);
    const want = near * (1 - 0.6 * habit);
    attn += (want - attn) * (1 - Math.exp(-dt / (want > attn ? 0.25 : 0.7)));
    excite *= Math.exp(-dt / 3.5);
    squash += ((pressed ? 1 : 0) - squash) * (1 - Math.exp(-dt / 0.07));
    for (let k = kicks.length - 1; k >= 0; k--) {
      const c = kicks[k]!;
      if (c.due > now) continue;
      const d = st[c.dot]!;
      d.jvx += c.vx;
      d.jvy += c.vy;
      d.jvs += c.vs;
      kicks.splice(k, 1);
    }

    if (!pass && now >= hold.until) startPass(now);
    if (pass && style) {
      const p = pass;
      const ramp = p.dur * 0.75;
      let settled = true;
      st.forEach((d, i) => {
        const tl = now - p.t0 - p.lags[i]!;
        // A spring chasing an eased target: starts from rest, settles with a faint overshoot.
        [d.p, d.v] = spring(
          d.p,
          d.v,
          easeInOut(tl / ramp),
          p.omega,
          p.zeta,
          dt,
        );
        if (tl < ramp || Math.abs(1 - d.p) > 0.003 || Math.abs(d.v) > 0.03)
          settled = false;
      });
      if (settled) endPass(now, p, style);
    }

    const pose = style ? DOT_STYLES[style].pose : null;
    const span = Math.max(1, hold.until - hold.t0);
    const holdW = pass
      ? 0
      : Math.sin(Math.PI * clamp01((now - hold.t0) / span)) ** 2;
    const breathMs = BREATH_MS / (1 + 0.8 * clamp01(excite));
    // The dot nearest the pointer is the one that reaches for it.
    let nearest = -1;
    if (ptr && attn > 0.001) {
      let best = Infinity;
      st.forEach((d, i) => {
        const [x, y] = d.prev ?? [REST_X[i]!, 0];
        const dist = Math.hypot(ptr!.x - x, ptr!.y - y);
        if (dist < best) {
          best = dist;
          nearest = i;
        }
      });
    }
    const probe = 0.45 + 0.55 * noise(now / 650 + 7);

    poses = dots.map((el, i) => {
      const d = st[i]!;
      const {
        x: x0 = 0,
        y: y0 = 0,
        s: s0 = 1,
        halo: h0 = 0,
      } = pass && pose ? pose(d.p, i, pass.amp) : {};
      [d.jx, d.jvx] = spring(d.jx, d.jvx, 0, JOLT_OMEGA, 0.3, dt);
      [d.jy, d.jvy] = spring(d.jy, d.jvy, 0, JOLT_OMEGA, 0.3, dt);
      [d.js, d.jvs] = spring(d.js, d.jvs, 0, JOLT_OMEGA, 0.4, dt);
      // sniff: the nearest dot reaches out toward the pointer, tentatively — out, back a little,
      // out again — never past it. Pressed, the row huddles to the middle.
      let tx = squash * (PITCH - REST_X[i]!) * 0.3;
      let ty = 0;
      if (i === nearest && ptr && d.prev) {
        const dx = ptr.x - d.prev[0];
        const dy = ptr.y - d.prev[1];
        const len = Math.hypot(dx, dy) || 1;
        const m = Math.min(3.8 * probe * attn, Math.max(0, len - 3));
        tx += (dx / len) * m;
        ty += (dy / len) * m;
      }
      [d.lx, d.lvx] = spring(d.lx, d.lvx, tx, LEAN_OMEGA, 0.55, dt);
      [d.ly, d.lvy] = spring(d.ly, d.lvy, ty, LEAN_OMEGA, 0.55, dt);

      const x = x0 + d.jx + d.lx;
      const y = y0 + d.jy + d.ly;
      const px = REST_X[i]! + x;
      // Keyed to where the dot IS, not which element it is, so leap's hand-over never pops.
      const phase = px / PITCH;
      let s = s0 * (1 + d.js) * (1 - 0.2 * squash);
      if (holdW) {
        s *=
          1 -
          0.05 *
            holdW *
            (0.5 +
              0.5 * Math.sin((2 * Math.PI * now) / breathMs + phase * 1.3));
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
        const halo = Math.min(
          1,
          h0 + 0.35 * clamp01(excite) * (i === 0 ? 1 : 0.5),
        );
        h.style.opacity = String(0.25 * halo);
        h.style.transform = `translate(${x * unit}px, ${y * unit}px) scale(${s * (1 + 0.9 * halo)})`;
      }
      return { x: x0, y: y0, s: s0 };
    });
    raf = requestAnimationFrame(frame);
  }

  function stop() {
    cancelAnimationFrame(raf);
    raf = 0;
  }

  return {
    start() {
      if (raf) return;
      measureUnit();
      last = performance.now();
      raf = requestAnimationFrame(frame);
    },
    stop,
    destroy() {
      stop();
      window.removeEventListener("pointermove", onMove);
      document.documentElement.removeEventListener("pointerleave", onLeave);
      box.removeEventListener("pointerdown", onDown);
      box.removeEventListener("pointerup", onUp);
      box.removeEventListener("pointercancel", onCancel);
    },
  };
}
