import { createInViewWatcher } from "@plugins/primitives/plugins/dom/plugins/in-view/web";
import { STORY_PALETTE_DECLS } from "@plugins/apps/plugins/website/plugins/pages/plugins/story/core";

/* The kit both head figures are drawn with — the head, the robot, the travelling thought — ported verbatim
   from the prototype's `heads.js` (`proto-1794207359-w7ez6h`, at its default `head: profile`).
   Colours only through --fg, --fg2, --fg3, --line, --panel and --hl (the story palette, set on the host). */

export const rnd = (a: number, b: number) => a + Math.random() * (b - a);
export const pick = <T>(a: readonly T[]): T =>
  a[Math.floor(Math.random() * a.length)]!;
export const clamp = (v: number, a: number, b: number) =>
  Math.max(a, Math.min(b, v));
export const ease = (p: number) =>
  p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2;
export const easeOut = (p: number) => 1 - Math.pow(1 - p, 3);
export type Pt = [number, number];

/* ------------------------------------------------------------------ the head
   The head sits in one frame (viewBox "70 30 440 545"), faces right, and says where its features are in
   frame units, so the figures place things by anatomy. */
export const FRAME = { x: 70, y: 30, w: 440, h: 545 };
const STROKE = `stroke="var(--fg)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" vector-effect="non-scaling-stroke"`;
// the approved line profile
export const HEAD = {
  svg: `<path transform="translate(580 0) scale(-1 1)" d="M437 505 C428 470 418 430 428 385 C445 340 478 290 484 220 C492 120 410 48 305 48 C205 48 135 110 128 205 C126 225 132 238 140 248 C128 275 110 300 98 322 C96 330 110 336 130 338 C136 345 130 355 131 362 C137 368 132 374 133 378 C142 386 146 392 144 402 C140 425 146 445 170 452 C195 458 225 448 236 458 C242 470 238 520 232 565" fill="none" ${STROKE}/>`,
  face: 490,
  neck: 348,
  chin: 440,
  brain: [264, 190, 62, 74] as const,
  skull: [275, 215, 167] as const,
};

/* one size for both figures, from the figure's width: a 236px head and full-size robots from ~660px wide */
export const headHeight = (W: number) => Math.round(clamp(W * 0.36, 150, 236));
export const botScale = (W: number) => clamp(0.62 + W * 0.00058, 0.8, 1);
export interface HeadGeom {
  H: number;
  W: number;
  k: number;
  ox: number;
  oy: number;
  X(x: number): number;
  Y(y: number): number;
  brain: Pt;
  brainR: Pt;
  skullC: Pt;
  skullR: number;
  /** the top of the skull above x (for robots standing on my head) */
  top(x: number): number;
}
export function headGeom(H: number, ox: number, oy: number): HeadGeom {
  const k = H / FRAME.h,
    X = (x: number) => ox + (x - FRAME.x) * k,
    Y = (y: number) => oy + (y - FRAME.y) * k;
  const [bx, by, brx, bry] = HEAD.brain,
    [sx, sy, sr] = HEAD.skull;
  return {
    H,
    W: FRAME.w * k,
    k,
    X,
    Y,
    ox,
    oy,
    brain: [X(bx), Y(by)],
    brainR: [brx * k, bry * k],
    skullC: [X(sx), Y(sy)],
    skullR: sr * k,
    top: (x) => {
      const dx = clamp((x - X(sx)) / k, -sr * 0.8, sr * 0.8);
      return Y(sy - Math.sqrt(sr * sr - dx * dx));
    },
  };
}
export const headSVG = (g: HeadGeom) =>
  `<svg class="head" viewBox="${FRAME.x} ${FRAME.y} ${FRAME.w} ${FRAME.h}" width="${g.W.toFixed(1)}" height="${g.H}" style="left:${g.ox.toFixed(1)}px;top:${g.oy.toFixed(1)}px" aria-hidden="true">${HEAD.svg}</svg>`;

/** run `start` while on screen, `stop` once scrolled away; answers the disposer */
export function whileVisible(
  el: Element,
  start: () => void,
  stop: () => void,
): () => void {
  const io = createInViewWatcher(
    (es) => {
      for (const e of es) (e.isIntersecting ? start : stop)();
    },
    { threshold: 0.05 },
  );
  io.observe(el);
  return () => {
    io.disconnect();
    stop();
  };
}
/** a requestAnimationFrame loop that can be paused, handing each frame its dt in seconds */
export function loop(tick: (dt: number) => void) {
  let raf = 0,
    last = 0;
  // a frame's timestamp can be earlier than the performance.now() it started from: never a negative step, and
  // never a leap (a hidden tab, a scroll back on screen) — the figure picks up where it stopped
  const frame = (now: number) => {
    raf = requestAnimationFrame(frame);
    const dt = clamp((now - last) / 1000, 0, 0.05);
    last = Math.max(last, now);
    tick(dt);
  };
  return {
    start() {
      if (!raf) {
        last = performance.now();
        raf = requestAnimationFrame(frame);
      }
    },
    stop() {
      cancelAnimationFrame(raf);
      raf = 0;
    },
  };
}

/* ------------------------------------------------------------------ the robot (30×36, feet at the bottom centre)
   One drawing, dressed by classes on its .ag: waiting (a "!" and a wave), working (a spinner on the antenna,
   and either a hammer on an anvil with sparks or a tapping finger on a floating screen of code), reviewed
   (the highlight), closed (a tick), and an idea (a thought cloud). */
const BOT = `<svg class="bot" viewBox="0 0 30 36" width="30" height="36" aria-hidden="true"><ellipse class="shadow" cx="15" cy="35.6" rx="9" ry="1.6" fill="currentColor"/><g fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
      <g class="scr"><rect x="-18" y="5" width="16" height="12.5" rx="2.4" fill="var(--panel)"/><path class="code c1" d="M-15 9 H-7"/><path class="code c2" d="M-13 11.6 H-5.5"/><path class="code c3" d="M-15 14.2 H-9"/></g>
      <path d="M15 8 V4.4"/><circle class="tip" cx="15" cy="2.8" r="1.6" fill="currentColor"/>
      <circle class="spin" cx="15" cy="2.8" r="4.3" stroke-width="1.2" stroke-dasharray="15 12"/>
      <rect x="6" y="8" width="18" height="13" rx="5" fill="var(--panel)"/>
      <g class="eyes"><circle cx="11.6" cy="14.5" r="1.3" fill="currentColor" stroke="none"/><circle cx="18.4" cy="14.5" r="1.3" fill="currentColor" stroke="none"/></g>
      <rect x="9" y="23" width="12" height="9" rx="3" fill="var(--panel)"/>
      <path class="armL" d="M9 26 L5 30"/><path class="tap" d="M9 25.5 L0.5 18.5"/>
      <path class="armR" d="M21 26 L25 30"/>
      <path d="M12 32 V35 M18 32 V35"/>
      <path class="anvil" d="M28 31.6 H38.5 L37 33.4 V35.4 H29.5 V33.4 Z" fill="var(--panel)"/>
      <g class="ham"><path d="M21 26 L27 22 V14.4"/><rect x="23" y="10" width="8" height="4.4" rx="1.2" fill="var(--panel)"/></g>
      <g class="sparks"><path d="M30.6 29.4 L28.6 26.2 M33.4 28.4 L33.8 24.8 M37.2 29.4 L40 27.2 M38.6 31.4 L41.6 31"/></g>
    </g>
    <g class="cloud" stroke="currentColor" stroke-width="1.5"><circle cx="9" cy="33" r="1.6" fill="var(--panel)"/><circle cx="12" cy="28.6" r="2.4" fill="var(--panel)"/>
      <path d="M9 23 C2 21.5 3.5 11 11 12.5 C13 6 22.5 6 23.5 12.5 C30 12 30 23 23.5 23 Z" fill="var(--panel)"/><g fill="currentColor" stroke="none"><circle cx="11.5" cy="17.6" r="1.2"/><circle cx="16" cy="17.6" r="1.2"/><circle cx="20.5" cy="17.6" r="1.2"/></g></g>
    <text class="bang" x="28" y="8" text-anchor="middle" font-size="11" font-weight="700" fill="currentColor">!</text>
    <text class="tick" x="28" y="9" text-anchor="middle" font-size="12" font-weight="700" fill="currentColor">✓</text></svg>`;
const BOT_CSS = `
    .ag { position: absolute; left: 0; top: 0; width: 30px; height: 36px; transform-origin: 15px 36px; color: var(--fg); will-change: transform; transition: color .5s, opacity .5s; }
    .fig { position: absolute; inset: 0; transition: transform .25s; }
    .ag.flip .fig { transform: scaleX(-1); }
    .bot { position: absolute; left: 0; top: 0; overflow: visible; }
    .bot > g:first-of-type, .cloud { transition: opacity .3s; }
    .shadow { opacity: 0; transition: opacity .4s; } .work .shadow { opacity: .14; }
    .bang, .tick, .spin, .scr, .tap, .anvil, .ham, .sparks, .cloud { opacity: 0; transition: opacity .3s; }
    .eyes { transition: transform .4s cubic-bezier(.3,.7,.2,1); }
    .look-l .eyes { transform: translateX(-1.6px); } .look-r .eyes { transform: translateX(1.6px); }
    /* waiting / calling: a "!" and, now and then, a wave */
    .wait .bang, .call .bang, .done .bang { opacity: 1; }
    .armR { transform-box: view-box; transform-origin: 21px 26px; }
    .wait .armR, .call .armR { animation: wave var(--wp, 3.2s) ease-in-out var(--wd, 0s) infinite; }
    @keyframes wave { 0%, 58%, 100% { transform: rotate(0deg); } 66%, 82% { transform: rotate(-120deg); } 74%, 90% { transform: rotate(-150deg); } }
    .call .armR { animation-duration: 1.1s; }
    @keyframes waveFast { 0%, 100% { transform: rotate(-115deg); } 50% { transform: rotate(-155deg); } }
    .call .armR { animation-name: waveFast; }
    /* working */
    .work { color: var(--fg2); }
    .work .spin { opacity: 1; }
    .spin { transform-box: fill-box; transform-origin: center; animation: spin .8s linear infinite; }
    @keyframes spin { to { transform: rotate(360deg); } }
    .work.busy.hammer .ham, .work.busy.hammer .anvil, .work.busy.hammer .sparks { opacity: 1; } .work.busy.hammer .armR { opacity: 0; }
    .ham { transform-box: view-box; transform-origin: 21px 26px; transform: rotate(16deg); animation: hammer var(--hp, .62s) cubic-bezier(.5,0,.6,1) var(--hd, 0s) infinite; }
    @keyframes hammer { 0% { transform: rotate(16deg); } 50% { transform: rotate(-2deg); } 72% { transform: rotate(77deg); } 80% { transform: rotate(70deg); } 100% { transform: rotate(16deg); } }
    .sparks { transform-box: fill-box; transform-origin: 0 100%; }
    .work.busy.hammer .sparks { animation: spark var(--hp, .62s) linear var(--hd, 0s) infinite; }
    @keyframes spark { 0%, 70% { opacity: 0; transform: scale(.4); } 74% { opacity: 1; transform: scale(.9); } 92% { opacity: 0; transform: scale(1.35); } 100% { opacity: 0; } }
    .work.busy.screen .scr, .work.busy.screen .tap { opacity: 1; } .work.busy.screen .armL { opacity: 0; }
    .tap { transform-box: view-box; transform-origin: 9px 25.5px; }
    .work.busy.screen .tap { animation: tap .32s ease-in-out var(--hd, 0s) infinite alternate; }
    @keyframes tap { from { transform: rotate(-6deg); } to { transform: rotate(10deg); } }
    .code { stroke-width: 1.3; stroke-dasharray: 9 9; stroke-dashoffset: 9; }
    .work.busy.screen .code { animation: type 1.5s steps(5) var(--hd, 0s) infinite; }
    .work.busy.screen .c2 { animation-delay: calc(var(--hd, 0s) - .5s); } .work.busy.screen .c3 { animation-delay: calc(var(--hd, 0s) - 1s); }
    @keyframes type { 0% { stroke-dashoffset: 9; } 80%, 100% { stroke-dashoffset: 0; } }
    /* attention */
    .review, .loud, .idea { color: var(--hl); }
    .review .bang { opacity: 0; }
    .close { color: var(--hl); } .close .tick { opacity: 1; } .close .bang { opacity: 0; }
    .idea .bot > g:first-of-type, .idea .shadow, .idea .bang { opacity: 0; } .idea .cloud { opacity: 1; }
    @media (prefers-reduced-motion: reduce) { .spin, .ham, .sparks, .tap, .code, .armR { animation: none !important; } .code { stroke-dashoffset: 0; } }`;

export function makeBot(
  parent: Element,
  before?: Element | null,
): HTMLDivElement {
  const el = document.createElement("div");
  el.className = "ag";
  el.innerHTML = `<div class="fig">${BOT}</div>`;
  el.style.setProperty("--wp", rnd(2.6, 4.2).toFixed(2) + "s");
  el.style.setProperty("--wd", (-rnd(0, 4)).toFixed(2) + "s");
  el.style.setProperty("--hp", rnd(0.52, 0.72).toFixed(2) + "s");
  el.style.setProperty("--hd", (-rnd(0, 1.5)).toFixed(2) + "s");
  parent.insertBefore(el, before ?? null);
  return el;
}

/** something moved by tweens: a robot, a phrase, an answer */
export interface Tween {
  from: Pt;
  to: Pt;
  mid: Pt;
  t0: number;
  dur: number;
  sc0: number;
  sc1: number;
  hop: number;
  done?: (() => void) | undefined;
}
export interface Mover {
  el: HTMLElement;
  x: number;
  y: number;
  sc: number;
  tw: Tween | null;
}
/* tweens: move along a quadratic arc through `mid`, easing in and out, with little steps on the way */
export function go(
  v: Mover,
  t: number,
  to: Pt,
  {
    dur,
    mid,
    sc = v.sc,
    hop = 2.6,
    done,
  }: { dur: number; mid?: Pt; sc?: number; hop?: number; done?: () => void },
) {
  const from: Pt = [v.x, v.y];
  v.tw = {
    from,
    to,
    mid: mid ?? [(from[0] + to[0]) / 2, Math.min(from[1], to[1]) - 20],
    t0: t,
    dur,
    sc0: v.sc,
    sc1: sc,
    hop,
    done,
  };
}
export function stepTween(v: Mover, t: number): number {
  const tw = v.tw;
  if (!tw) return 0;
  const p = clamp((t - tw.t0) / tw.dur, 0, 1),
    e = ease(p),
    q = 1 - e;
  v.x = q * q * tw.from[0] + 2 * q * e * tw.mid[0] + e * e * tw.to[0];
  v.y = q * q * tw.from[1] + 2 * q * e * tw.mid[1] + e * e * tw.to[1];
  v.sc = tw.sc0 + (tw.sc1 - tw.sc0) * easeOut(p);
  const bob = tw.hop
    ? -Math.abs(Math.sin(p * Math.PI * Math.max(2, Math.round(tw.dur * 4)))) *
      tw.hop *
      Math.sin(p * Math.PI)
    : 0;
  if (p >= 1) {
    v.tw = null;
    tw.done?.();
  }
  return bob;
}
export const place = (v: Mover, bob = 0, rot = 0, dx = 0) => {
  v.el.style.transform = `translate(${(v.x + dx - 15).toFixed(2)}px, ${(v.y - 36 + bob).toFixed(2)}px) scale(${v.sc.toFixed(3)})${rot ? ` rotate(${rot.toFixed(2)}deg)` : ""}`;
};
/* idle motion (a hop, a sway, a shuffle) eased in and out, so a change of state or of pace never snaps the
   robot: each wave runs on its own accumulated phase (a pace change bends it, never jumps it), and the pose
   follows its target through a short low-pass. */
export interface Pose {
  h: number;
  r: number;
  x: number;
  bob: number;
  rot: number;
  dx: number;
}
export function idle(
  v: { P?: Pose; ph?: number },
  dt: number,
  {
    hop = 0,
    hopF = 4,
    sway = 0,
    swayF = 3,
    shuffle = 0,
  }: {
    hop?: number;
    hopF?: number;
    sway?: number;
    swayF?: number;
    shuffle?: number;
  },
): Pose {
  const P = (v.P ??= {
    h: v.ph ?? 0,
    r: (v.ph ?? 0) * 1.7,
    x: (v.ph ?? 0) * 0.6,
    bob: 0,
    rot: 0,
    dx: 0,
  });
  P.h += dt * hopF;
  P.r += dt * swayF;
  P.x += dt * 1.3;
  const k = Math.min(1, dt * 14);
  P.bob += (-Math.abs(Math.sin(P.h)) * hop - P.bob) * k;
  P.rot += (Math.sin(P.r) * sway - P.rot) * k;
  P.dx += (Math.sin(P.x) * shuffle - P.dx) * k;
  return P;
}

/* the phrases both figures pass between an agent and my head, one look for both: an agent's question is
   `name · question` (phrase()), loud in --hl and a touch larger (LOUD) while it holds my attention, grey once
   it does not (<mind-overload> only: its head is never clear); my answer is a ✓ (done, the agent leaves) or a
   reply word (back to work). .word is a travelling thought (Thought, or an answer on its way out); .w a phrase
   drifting in the messy head. */
export const LOUD = 1.12,
  DONE = "✓";
export const phrase = (name: string, q: string) => `${name} · <i>${q}</i>`;
// the type follows the head: 12px in a full-size head, 10px in the smallest
export const phraseFont = (W: number) =>
  clamp(Math.round(headHeight(W) * 0.05 * 2) / 2, 10, 12);
/* fit a phrase (natural size w × h, drawn at scale sc, centred on p) inside my skull: moved sideways, and
   shrunk only when it is still too wide there, so its whole box stays inside the skull's circle with a margin.
   A point outside the skull is left alone (a phrase on its way to or from an agent), unless `force`. */
export function fitInHead(
  g: HeadGeom,
  p: Pt,
  w: number,
  h: number,
  sc: number,
  force = false,
): { p: Pt; sc: number } {
  const [cx, cy] = g.skullC,
    r = g.skullR - 6;
  if (!force && Math.hypot(p[0] - cx, p[1] - cy) > r) return { p, sc };
  const dy = Math.min(r * 0.9, Math.abs(p[1] - cy) + (h * sc) / 2),
    half = Math.sqrt(r * r - dy * dy);
  const s2 = sc * Math.min(1, (2 * half) / (w * sc)),
    hw = (w * s2) / 2;
  return { p: [clamp(p[0], cx - half + hw, cx + half - hw), p[1]], sc: s2 };
}
const THOUGHT_CSS = `
    .word { position: absolute; left: 0; top: 0; white-space: nowrap; line-height: 1; color: var(--hl); font-weight: 600; opacity: 0; transition: opacity .4s; pointer-events: none; will-change: transform; z-index: 5; }
    .word i { font-style: normal; }
    .word.on { opacity: 1; }
    .w { position: absolute; left: 0; top: 0; white-space: nowrap; line-height: 1; color: var(--fg2); will-change: transform, opacity; z-index: 4; transform-origin: 0 0; pointer-events: none; opacity: 0; }
    .w .in { display: block; transform: translate(-50%, -50%); transition: color .45s; }
    .w i { font-style: normal; color: var(--fg3); transition: color .45s; }
    .w.loud { z-index: 5; } .w.loud .in { color: var(--hl); font-weight: 600; } .w.loud i { color: var(--hl); }`;

/** the shadow root's stylesheet for a head figure: the palette, the box, the thoughts and the robots, plus its own rules */
export const figureCss = (extra = "") => `
        :host { ${STORY_PALETTE_DECLS}; display: block; }
        .box { position: relative; width: 100%; overflow: hidden; }
        .head { position: absolute; display: block; overflow: visible; }
        ${extra}
        ${THOUGHT_CSS}
        ${BOT_CSS}`;

/** what a thought is drawn in: the figure's clock, its width and its head */
export interface ThoughtHost {
  t: number;
  W: number;
  g: HeadGeom;
}
/* a thought that travels between a robot and my head along an arc. Two elements take turns: a new thought
   that starts away from where the last one is lets the old one fade where it stands (or finish fading), rather
   than snapping it across the figure while it is still visible. */
export class Thought {
  i = 0;
  el: HTMLElement;
  x = 0;
  y = 0;
  tw: Tween | null = null;
  sc = 1;
  constructor(
    private fig: ThoughtHost,
    readonly els: HTMLElement[],
  ) {
    this.el = els[0]!;
  }
  // `swap`: the new thought leaves on the other element even from where the last one is, which fades there (an
  // answer leaving my head while the question it answers fades in it); `sc`: LOUD for a question in my head
  say(
    html: string,
    from: Pt,
    to: Pt,
    dur: number,
    {
      lift = 0,
      delay = 0,
      done,
      swap = false,
      sc = 1,
    }: {
      lift?: number;
      delay?: number;
      done?: () => void;
      swap?: boolean;
      sc?: number;
    } = {},
  ) {
    // (even a hushed one may still be fading out)
    if (swap || Math.hypot(from[0] - this.x, from[1] - this.y) > 4) {
      this.el.classList.remove("on");
      this.i = (this.i + 1) % this.els.length;
      this.el = this.els[this.i]!;
    }
    const el = this.el;
    el.innerHTML = html;
    el.classList.add("on");
    // an end in my head fits inside my skull; the whole thought stays inside the figure, wherever its target is
    const w = el.offsetWidth,
      h = el.offsetHeight,
      A = fitInHead(this.fig.g, from, w, h, sc),
      B = fitInHead(this.fig.g, to, w, h, sc);
    const inX = (F: { p: Pt; sc: number }): Pt => {
      const half = (w * F.sc) / 2 + 4;
      return [clamp(F.p[0], half, this.fig.W - half), F.p[1]];
    };
    from = inX(A);
    to = inX(B);
    this.x = from[0];
    this.y = from[1];
    this.sc = A.sc;
    this.tw = {
      from,
      to,
      mid: [(from[0] + to[0]) / 2, Math.min(from[1], to[1]) - lift],
      t0: this.fig.t + delay,
      dur,
      done,
      sc0: A.sc,
      sc1: B.sc,
      hop: 0,
    };
    this.draw();
  }
  hush() {
    this.el.classList.remove("on");
  }
  step(t: number) {
    const tw = this.tw;
    if (tw) {
      const p = clamp((t - tw.t0) / tw.dur, 0, 1),
        e = ease(p),
        q = 1 - e;
      this.x = q * q * tw.from[0] + 2 * q * e * tw.mid[0] + e * e * tw.to[0];
      this.y = q * q * tw.from[1] + 2 * q * e * tw.mid[1] + e * e * tw.to[1];
      this.sc = tw.sc0 + (tw.sc1 - tw.sc0) * e;
      if (p >= 1) {
        this.tw = null;
        tw.done?.();
      }
    }
    this.draw();
  }
  draw() {
    this.el.style.transform = `translate(${this.x.toFixed(2)}px, ${this.y.toFixed(2)}px) translate(-50%, -50%)${this.sc !== 1 ? ` scale(${this.sc.toFixed(3)})` : ""}`;
  }
}

/** a head figure: drawn into its host's shadow root; `layout` on a width change, `dispose` on unmount */
export interface HeadFigure {
  layout(): void;
  dispose(): void;
}
