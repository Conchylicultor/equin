import { createInViewWatcher } from "@plugins/primitives/plugins/dom/plugins/in-view/web";
import { clamp01, latch, smooth, type Pt } from "./kit/math";
import { disc } from "./kit/night";
import { C } from "./kit/palette";
import { all, circ, one } from "./kit/svg";
import { mountApart } from "./chapters/apart";
import { appFrame } from "./chapters/app";
import { desktopFrame } from "./chapters/desktop";
import type { Frame, LiveFrame } from "./chapters/frame";
import { IN } from "./chapters/geometry";
import { mountGlobe } from "./chapters/globe";
import { ideaFrame, mountWishes } from "./chapters/idea";
import { integrateFrame } from "./chapters/integrate";
import { mountOrbitDesktop } from "./chapters/os-orbit";
import { mountShared, type World } from "./chapters/shared";

/**
 * The zoom: Powers of Ten. One nested frame per chapter of the ladder, driven
 * continuously by scroll progress p: frame k fills the scene at p = k, and at
 * p = k + 1 it is a smaller thing inside frame k + 1. Each frame is two
 * layers: its disc (back), which dissolves as you zoom out of it so the frame
 * melts into its parent, and its drawing (front). Drawn as night orbs on a
 * starfield.
 *
 * The hand-offs between chapters are part of the drawing, not a cut:
 *   0 → 1  the idea's spark becomes the spark in the app's title bar
 *   1 → 2  the app itself (frame 1, settled back to its plain layout) hosts the apps that open in it
 *   2 → 3  chapter 2 stops as it is, and the apps on screen come apart into windows of the OS
 *   3 → 4  your OS sits among other people's
 *   4 → 5  everyone's, a city of lights on the earth by night
 */

/** 2 → 3: chapter 2 plays on while the zoom moves out; at p = SPLIT it stops where it is and comes apart. */
const SPLIT = 2.3;
const SPLIT_LEN = 0.65;
/** …and is put back together only below SPLIT_BACK: a page at rest at SPLIT does not take it apart and back again. */
const SPLIT_BACK = 2.24;

/** Frame k's drawing fades in over p ∈ [k - 1 + FIN_AT, k - 1 + FIN_AT + FIN_LEN]. */
const FIN_AT = 0.25;
const FIN_LEN = 0.55;
/**
 * At p = k + COVERED frame k + 1's drawing has fully faded in over frame k: frame k's loop rests
 * (back at its start) from there on. Played on beneath, it would still show wherever the next
 * frame does not cover it (chapter 1's spark, in the title bar above chapter 2's apps, sending
 * out a wish every step that flashes and dives under them).
 */
const COVERED = FIN_AT + FIN_LEN;

export interface Zoom {
  /** p: continuous progress, 0 (an idea) … 5 (every app). */
  update(p: number): void;
  /** The stage changed size. */
  resize(): void;
  /**
   * Where a card is read, in px from the top of the screen: where the copy sits beside or under the
   * scene, given the scene's layout. The ladder holds the picture at a chapter while its card's
   * centre is there.
   */
  readingLine(): number;
  dispose(): void;
}

function frames(prefix: string): Frame[] {
  return [
    ideaFrame(prefix),
    appFrame(prefix),
    integrateFrame(prefix),
    desktopFrame(prefix),
    // 4 — shared: your orbit in the middle, everyone's own orbit drifting around it (shared.ts)
    {
      back: disc(
        `${prefix}g4`,
        `<radialGradient id="${prefix}zglow4c"><stop offset="0" stop-color="${C.azure}" stop-opacity=".2"/><stop offset="1" stop-color="${C.azure}" stop-opacity="0"/></radialGradient>` +
          `<g class="zb-breath">${circ(0, 0, 125, "zb-glow", `fill="url(#${prefix}zglow4c)"`)}</g>`,
      ),
      front: '<g class="zb-shared"></g>',
    },
    // 5 — every app: the earth by night (globe.ts). Its grid and lights are on the back, beneath frame 4.
    {
      back: disc(`${prefix}g5`, '<g class="zb-shared-back"></g>'),
      front: '<g class="zb-shared"></g>',
    },
  ];
}

const svg = (s: string) =>
  `<svg viewBox="-500 -500 1000 1000" width="1000" height="1000">${s}</svg>`;

/**
 * Mount the zoom in `stage` (the pinned, empty stage). `prefix` keeps the
 * drawing's ids unique in the document; `ideaRead()` says whether the first
 * chapter's card is being read (its wishes stream only then).
 */
export function mountZoom(
  stage: HTMLElement,
  opts: { prefix: string; chapters: number; ideaRead: () => boolean },
): Zoom {
  const { prefix } = opts;
  const F = frames(prefix);
  const N = F.length;
  if (N !== opts.chapters)
    throw new Error(`zoom: ${N} frames for ${opts.chapters} chapters`);
  if (IN.length !== N - 1)
    throw new Error(`zoom: ${IN.length} placements for ${N} frames`);
  // backs: outer below inner; fronts above every back, outer above inner (a host draws over its guest)
  stage.innerHTML =
    '<div class="z-bg"><i></i><i></i><i></i></div><div class="z-scene">' +
    F.map(
      (f, k) =>
        `<div class="z-frame z-back" style="z-index:${20 - k}">${svg(f.back)}</div>`,
    ).join("") +
    F.map(
      (f, k) =>
        `<div class="z-frame z-front" style="z-index:${30 + k}">${svg(f.front)}</div>`,
    ).join("") +
    "</div>";
  const scene = one<HTMLElement>(stage, ".z-scene");
  const backs = all<HTMLElement>(stage, ".z-back");
  const fronts = all<HTMLElement>(stage, ".z-front");
  const bg = all<HTMLElement>(stage, ".z-bg i");
  const front = (k: number) => fronts[k]!;
  const wish = mountWishes(front(0));

  // each frame's size and centre in units of the biggest frame
  const S: number[] = [];
  const W: Pt[] = [];
  S[N - 1] = 1;
  W[N - 1] = [0, 0];
  for (let i = N - 2; i >= 0; i--) {
    S[i] = S[i + 1]! / IN[i]!.r;
    W[i] = [
      W[i + 1]![0] + IN[i]!.o[0] * S[i + 1]!,
      W[i + 1]![1] + IN[i]!.o[1] * S[i + 1]!,
    ];
  }

  const timelines = F.map((f) => f.timeline ?? null);
  timelines.forEach((sc, k) => sc?.bind(front(k)));
  const chapter2 = timelines[2]!;
  const os = mountOrbitDesktop(
    one(front(3), ".zb-os-back"),
    one(front(3), ".zb-os-front"),
    prefix,
  );
  const pieces = mountApart(one(front(3), ".zb-apart"), chapter2, () =>
    os.places(),
  );
  // what chapters 4 and 5 share: once chapter 4's orbits are nodes, they ride chapter 5's turning globe
  const world: World = {};
  const r3 = IN[3]!;
  const r4 = IN[4]!;
  const lives: (LiveFrame | null)[] = [
    null,
    null,
    null,
    null,
    // your orbit (frame 3) trades apps with everyone's: placed in this frame by IN[3]
    mountShared(
      one(front(4), ".zb-shared"),
      os.home((x, y) => [r3.o[0] + x / r3.r, r3.o[1] + y / r3.r, 1 / r3.r]),
      r3.r,
      r4.r,
      world,
      (c) => [r4.o[0] + c[0] / r4.r, r4.o[1] + c[1] / r4.r],
      prefix,
    ),
    mountGlobe(
      one(front(5), ".zb-shared"),
      one(backs[5]!, ".zb-shared-back"),
      { at: r4.o },
      r4.r,
      world,
    ),
  ];

  let u = 1;
  let readAt = 0;
  let last = 0;
  let lastP = -1;
  let split = false;
  const splitAt = latch(SPLIT, SPLIT_BACK);
  /** Chapter 2's loop stops where it is while it is taken apart. */
  const frozen = (k: number) => k === 2 && split;
  let sep = 0;
  const baseBack: number[] = [];
  const baseFront: number[] = [];
  const vis: boolean[] = [];

  function layout() {
    const w = stage.clientWidth;
    const h = stage.clientHeight;
    let U: number;
    let cx: number;
    let cy: number;
    if (w >= 1000) {
      const avail = w - 560;
      U = Math.min(h * 0.8, avail * 0.96);
      cx = 490 + avail / 2;
      cy = h * 0.5;
      // the copy is beside the scene: read at the screen's middle
      readAt = h / 2;
    } else {
      U = Math.min(h * 0.5, w * 0.92);
      cx = w / 2;
      cy = h * 0.33;
      // the copy is under the scene: read in the middle of what is left below it
      readAt = (cy + U / 2 + h) / 2;
    }
    u = U / 1000;
    scene.style.left = `${cx}px`;
    scene.style.top = `${cy}px`;
  }

  // opacities: scroll sets the base; once chapter 2 has come apart, its pieces stand in for it
  // (frame 2 hidden), and the window it played in (frame 1) fades as they leave
  function paint() {
    for (let k = 0; k < N; k++) {
      let fo = baseFront[k]!;
      if (k === 2 && split) fo = 0;
      if (k === 1) fo *= 1 - smooth(sep / 0.3);
      const b = backs[k]!;
      const f = fronts[k]!;
      b.style.visibility =
        vis[k] && baseBack[k]! > 0.002 ? "visible" : "hidden";
      f.style.visibility = vis[k] && fo > 0.002 ? "visible" : "hidden";
      b.style.opacity = baseBack[k]!.toFixed(3);
      f.style.opacity = fo.toFixed(3);
    }
  }

  function update(p: number) {
    last = p;
    const k0 = Math.min(N - 2, Math.floor(p));
    const t = p - k0;
    const r = IN[k0]!.r;
    const gk = (Math.pow(r, t) - 1) / (r - 1);
    const cxw = W[k0]![0] + (W[k0 + 1]![0] - W[k0]![0]) * gk;
    const cyw = W[k0]![1] + (W[k0 + 1]![1] - W[k0]![1]) * gk;
    const Cam = S[k0]! * Math.pow(r, t); // the camera: the size of what fills the scene
    for (let k = 0; k < N; k++) {
      const s = S[k]! / Cam;
      const fin =
        k === 0 || F[k]!.selfFades
          ? 1
          : smooth((p - (k - 1) - FIN_AT) / FIN_LEN);
      baseBack[k] =
        (k === 0 ? 1 : smooth((p - (k - 1)) / 0.5)) *
        (k === N - 1 ? 1 : 1 - smooth((p - k) / 0.8));
      // (frame 0: the spark in the title bar takes over)
      baseFront[k] =
        fin *
        (1 - smooth((p - k - 2.2) / 1.0)) *
        (k === 0 ? 1 - smooth((p - 0.55) / 0.4) : 1);
      vis[k] = s < 8 && s > 0.002;
      if (!vis[k]) continue;
      const tr = `translate(${(((W[k]![0] - cxw) / Cam) * u).toFixed(2)}px,${(((W[k]![1] - cyw) / Cam) * u).toFixed(2)}px) scale(${(s * u).toPrecision(6)})`;
      backs[k]!.style.transform = tr;
      fronts[k]!.style.transform = tr;
    }
    // 2 → 3: past SPLIT, chapter 2 is frozen as it is and taken apart; back before SPLIT_BACK, it plays on
    const apart = splitAt(p);
    if (apart && !split) {
      chapter2.render();
      pieces.split();
      split = true;
      os.windows(pieces.list());
    } else if (!apart && split) {
      pieces.clear();
      split = false;
      os.windows([]);
    }
    sep = split ? clamp01((p - SPLIT) / SPLIT_LEN) : 0;
    if (split) pieces.pose(sep);
    os.update(p, sep);
    for (const l of lives) l?.update(p);
    paint();
    // a chapter's loop starts over while it is still hidden, so it is seen from its beginning, and
    // rests at its start once the next chapter covers it (chapter 2's is frozen by the split before)
    timelines.forEach((sc, k) => {
      if (!sc || frozen(k)) return;
      const crossed = (at: number) => lastP < at && p >= at;
      if (crossed(k - 0.8) || crossed(k + COVERED)) sc.restart();
    });
    lastP = p;
    wish.setOn(p < 0.6 && opts.ideaRead());
    bg.forEach((b, j) => {
      const f = (((j / 3 - p * 0.45) % 1) + 1) % 1;
      b.style.transform = `scale(${Math.pow(3, f).toFixed(3)})`;
      b.style.opacity = Math.sin(Math.PI * f).toFixed(3);
    });
  }

  // The frames' own animations run on their own clock, only while the zoom is on screen and the tab
  // visible. Chapter 2's stops while it is taken apart.
  let running = false;
  let onScreen = false;
  let prev: number | null = null;
  let raf = 0;
  const shown = (k: number) => fronts[k]!.style.visibility === "visible";
  // a loop plays while its frame is on screen and not yet covered by the next one
  const playing = (k: number) => shown(k) && !frozen(k) && last < k + COVERED;
  function play(now: number) {
    if (!running) {
      prev = null;
      return;
    }
    const dt = prev == null ? 0 : Math.min(0.1, (now - prev) / 1000);
    prev = now;
    // the next frame is asked for first: an error in one chapter's drawing still shows in the console, but
    // can no longer stop every animation on the page for good (the loop believing itself still running)
    raf = requestAnimationFrame(play);
    // only what is on screen is animated: a hidden frame's loop waits (a timeline is reset before it shows)
    timelines.forEach((sc, k) => {
      if (sc && playing(k)) {
        sc.advance(dt);
        sc.render();
      }
    });
    if (shown(0)) wish.tick(dt);
    if (shown(3)) os.tick(dt);
    lives.forEach((l, k) => {
      if (l && shown(k)) l.tick(dt);
    });
  }
  function setRunning() {
    const want = onScreen && !document.hidden;
    if (want === running) return;
    running = want;
    if (running) raf = requestAnimationFrame(play);
    else {
      cancelAnimationFrame(raf);
      prev = null;
    }
  }
  const watcher = createInViewWatcher((es) => {
    onScreen = es[es.length - 1]!.isIntersecting;
    setRunning();
  });
  watcher.observe(stage);
  document.addEventListener("visibilitychange", setRunning);

  layout();
  update(0);
  return {
    update,
    resize() {
      layout();
      update(last);
    },
    readingLine: () => readAt,
    dispose() {
      watcher.disconnect();
      document.removeEventListener("visibilitychange", setRunning);
      running = false;
      cancelAnimationFrame(raf);
    },
  };
}
