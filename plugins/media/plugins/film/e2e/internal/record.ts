// The session recorder: drive a real page with scripted inputs and capture it
// as a frame-exact sequence — frame i shows the page exactly i / fps seconds of
// PAGE time after frame 0, however long each screenshot took.
//
// The page runs on a virtual clock (page/clock.ts, an init script): from
// `record()` on, its time (performance.now, Date, timers, rAF, and every CSS /
// WAAPI animation, paused and scrubbed) only moves when the recorder steps it,
// one frame at a time. Between steps the clock stands still while the
// recorder waits, in real time, for the page to settle — HTTP in flight, a
// socket or worker message awaiting its reply, images, fonts, the DOM still
// changing after a reply. So data the app loads after a click lands in the
// very frame after the click, as if the network were instant: no stalls, no
// pop-ins, and the app's own transitions play at their real speed.
//
// Inputs (move, click, type, drag, wheel) are real Playwright input events,
// spread over frames, and logged with their time and position (the
// sequence's `input`), so a film can draw the cursor and place camera moves
// and SFX on them.
//
//   await installRecorderClock(context);        // before the page loads
//   await page.goto(…);                         // boots in real time
//   const seq = await record(page, { dir, name }, async (rec) => {
//     await rec.click(page.getByRole("button", { name: "Open" }));
//     await rec.hold(1.5);
//   });

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { BrowserContext, Locator, Page, Request } from "playwright";
import type { InputLog, Rect, Sequence } from "./assets";
import { bundlePageScript } from "./bundle";
import { ease, type Easing } from "./easing";
import type { ClockBusy, FilmDatePin } from "./page/clock";

/** A screen point (CSS px of the viewport) or an element (its centre, or `at` within its box, 0..1). */
export type RecTarget =
  | { x: number; y: number }
  | Locator
  | { element: Locator; at: { x: number; y: number } };

export interface SettleOptions {
  /** A frame that cannot settle within this (real ms) fails the recording. Default 30 000. */
  timeoutMs?: number;
  /** A request in flight longer than this (real ms) is long-lived (a stream, a worker load) and no longer waited on. Default 8 000. */
  staleRequestMs?: number;
  /** A socket / worker message with no reply after this (real ms) was fire-and-forget. Default 1 500. */
  replyMs?: number;
  /** After waiting on anything: how long (real ms) no message may arrive and the DOM must stay unchanged. Default 80. */
  quietMs?: number;
}

export interface RecordOptions {
  /** Frames go here (created). */
  dir: string;
  /** Frame files are `<name>-00000.<ext>`; the log is `<name>.json`. */
  name: string;
  fps?: number;
  /** Default jpeg (quality 92): a frame of 2560×1440 is ~0.4 MB instead of ~4. */
  format?: "jpeg" | "png";
  quality?: number;
  /** Where the pointer starts (default: the viewport centre). */
  cursor?: { x: number; y: number };
  settle?: SettleOptions;
}

export interface Recorder {
  readonly page: Page;
  /** Film time (s) of the next frame. */
  readonly t: number;
  /** Where the pointer is now (viewport CSS px). */
  readonly cursor: { x: number; y: number };
  /**
   * Capture `seconds` of the page doing nothing scripted. Every duration the
   * script gives (a hold, a move, a scroll) is PAGE time: under a
   * {@link Recorder.clockRate} below 1 it spans more frames.
   */
  hold(seconds: number): Promise<void>;
  /**
   * Slow motion at capture: from the next frame on, each frame advances the
   * page's clock by `rate` × 1/fps (CSS / WAAPI animations, timers, rAF —
   * everything on the virtual clock), and the script's own durations
   * (holds, moves, scrolls) stretch with it, so the page, the camera and
   * the hand slow together and stay smooth at the film's frame rate (no
   * frame is ever repeated). `over` (s of film) ramps the rate there
   * linearly instead of stepping it. Logged as `input.rate` (`[t, rate]`
   * per change), so the film knows which span is slowed.
   */
  clockRate(rate: number, opts?: { over?: number }): void;
  /**
   * Glide the pointer to a target (hover states follow it): ONE eased
   * gesture. `via` are points the path passes through on the way (a hand
   * curving around something it must not hover) — still one movement, one
   * ease over the whole path, never a stop at a waypoint.
   */
  move(
    target: RecTarget,
    opts?: {
      duration?: number;
      arc?: number;
      via?: readonly Point[];
      /**
       * The speed profile: `ease` (default) — an eased gesture, slow at both
       * ends; `steady` — a short ramp at each end and an even speed between,
       * for what drags content along (a slider): an eased drag's slow ends
       * move it by under a pixel a frame, which reads as stepping;
       * `performed` — an animator's hand: slow in, slow out a little past
       * the target, then a gentle settle back onto it, the path carrying a
       * slight, deterministic waver (never ruler-straight).
       */
      profile?: MoveProfile;
    },
  ): Promise<void>;
  /** Move to a target (one gesture, see `move`), rest a beat, press, release. */
  click(
    target: RecTarget,
    opts?: {
      duration?: number;
      dwell?: number;
      press?: number;
      via?: readonly Point[];
    },
  ): Promise<void>;
  /** Type into the focused element, one character at a time at `cps` characters per second (humanly uneven). */
  type(
    text: string,
    opts?: { cps?: number; jitter?: number; seed?: number },
  ): Promise<void>;
  /** Press one key (e.g. "Enter", "Meta+a") in the next frame. */
  press(key: string): Promise<void>;
  /** Press at `from`, move to `to` over `duration` (on `profile`, see `move`), release. */
  drag(
    from: RecTarget,
    to: RecTarget,
    opts?: { duration?: number; profile?: MoveProfile },
  ): Promise<void>;
  /**
   * Scroll the element under the pointer by `dy` px over `duration`. Refuses
   * a `dy` past the scroller's end: a wheel into the end overscrolls, and the
   * page bounces back (elastic overscroll) — the scroll must stop exactly
   * where the script meant it to.
   */
  wheel(dy: number, opts?: { duration?: number }): Promise<void>;
  /**
   * The camera's scroll: scroll `within`'s scroller (its nearest scrolling
   * ancestor) to `top` over `duration` s on `easing` (default `inOutQuad`:
   * at rest at both ends) — one absolute position per frame, so the move
   * lands exactly on `top`. Refuses a `top` the scroller cannot reach (past
   * its end it would overscroll and bounce), checked on every frame: content
   * still growing must keep ahead of the camera.
   */
  scrollTo(
    within: Locator,
    top: number,
    opts?: { duration?: number; easing?: Easing },
  ): Promise<void>;
  /**
   * Where `target` will be once every animation running on the page now
   * has finished — a row still opening, a block still fading in: on the
   * virtual clock every animation is scrubbed to its end for one synchronous
   * layout read, then put back (no frame is drawn in between). With its
   * scroller (nearest scrolling ancestor) at that settled layout: its visible
   * box, its scroll position and how far it can scroll. Viewport CSS px.
   */
  settledRect(target: Locator): Promise<SettledRect>;
  /**
   * Log `within`'s scroller position on every frame from now (the log's
   * `scroll`, `[t, scrollTop]`) until `stop()` — to check a camera move
   * frame by frame, and that nothing else scrolled the page.
   */
  watchScroll(within: Locator): { stop(): void };
  /**
   * Name this moment (and the rect of `target`, if given: an element's box,
   * or a rect the script measured — part of an element, say) in the log.
   */
  mark(name: string, target?: Locator | Rect): Promise<void>;
}

/**
 * Install the virtual clock on every page of `context`. Call before the page
 * you record loads.
 *
 * `date` (epoch ms) pins the page's calendar: the context's pages read that
 * instant now, and time runs on from it — across every page load of the
 * context (a reload never goes back in time), on the virtual clock once a
 * recording starts. So a recording shows the day and hour the film is set on,
 * not the day it was recorded.
 */
export async function installRecorderClock(
  context: BrowserContext,
  opts: { date?: number } = {},
): Promise<void> {
  const pin: FilmDatePin | null =
    opts.date === undefined ? null : { epoch: opts.date, realAt: Date.now() };
  await context.addInitScript({
    content: `window.__filmDatePin = ${JSON.stringify(pin)};\n${await bundlePageScript("clock-main.ts")}`,
  });
}

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

/** Deterministic noise in [0, 1) for typing rhythm. */
function rng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s = (Math.imul(s ^ (s >>> 15), 0x2c1b3c6d) + 0x6d2b79f5) >>> 0;
    s ^= s >>> 13;
    return (s >>> 0) / 4294967296;
  };
}

/** {@link Recorder.settledRect}'s answer. */
export interface SettledRect extends Rect {
  /** The target's scroller at the settled layout: its visible box's top and height, where it is scrolled to, and how far it can scroll. */
  scroller: {
    top: number;
    height: number;
    scrollTop: number;
    maxScrollTop: number;
  };
}

/** A move's speed profile (see {@link Recorder.move}). */
export type MoveProfile = "ease" | "steady" | "performed";

/**
 * A hand's reach: the minimum-jerk profile (10x³ − 15x⁴ + 6x⁵, Flash & Hogan
 * 1985) — how a person's pointing movement speeds up and slows down. Its peak
 * speed is 1.875× the average; inOutCubic's (the old default) is 3×, which
 * read as a dart across the screen on every long move.
 */
const reach = (x: number): number => x * x * x * (x * (6 * x - 15) + 10);

/**
 * Progress along a path at time fraction `x`: `ease` is a hand's reach
 * ({@link reach}); `steady`
 * ramps up over the first {@link STEADY_RAMP} of the time (smoothstep in
 * speed), runs at an even speed, and ramps down over the last.
 */
function progressAt(profile: MoveProfile, x: number): number {
  if (profile === "ease") return reach(x);
  if (profile === "performed") {
    // Slow in, slow out at PERFORMED_OVERSHOOT past the target (at rest
    // there: the hand's correction is a gesture of its own), then a gentle
    // settle back onto it.
    const o = PERFORMED_OVERSHOOT;
    const k = PERFORMED_SETTLE;
    if (x <= 1 - k) return (1 + o) * reach(x / (1 - k));
    return 1 + o - o * ease("inOutSine", (x - (1 - k)) / k);
  }
  const r = STEADY_RAMP;
  // Speed: a smoothstep 0 → 1 over [0, r], 1 over [r, 1 - r], 1 → 0 over
  // [1 - r, 1]; its integral, normalised to end at 1.
  const ramp = (u: number): number => u * u * u - (u * u * u * u) / 2; // ∫ smoothstep(u) du, for u in [0, 1]
  const total = 1 - 2 * r + 2 * r * ramp(1);
  let d: number;
  if (x <= r) d = r * ramp(x / r);
  else if (x >= 1 - r) d = total - r * ramp((1 - x) / r);
  else d = r * ramp(1) + (x - r);
  return d / total;
}
const STEADY_RAMP = 0.12;
/** How far past its target a `performed` move goes, as a fraction of its length. */
const PERFORMED_OVERSHOOT = 0.035;
/** The share of a `performed` move's time spent settling back from the overshoot. */
const PERFORMED_SETTLE = 0.24;
/** A `performed` path's waver: its largest sideways drift, px (capped at 1.5 % of the path). */
const PERFORMED_WAVER_PX = 3;

/**
 * A `performed` path's sideways waver at progress `u`: two slow,
 * incommensurate swells that vanish at both ends, so the hand still starts
 * and lands exactly where it was aimed — a person's slight drift, never a
 * ruler's line.
 */
function waver(u: number, dist: number): number {
  const amp = Math.min(PERFORMED_WAVER_PX, dist * 0.015);
  const w =
    0.7 * Math.sin(Math.PI * 1.7 * u + 0.6) + 0.3 * Math.sin(Math.PI * 4.3 * u);
  return amp * Math.sin(Math.PI * Math.min(1, Math.max(0, u))) * w;
}

export async function record(
  page: Page,
  opts: RecordOptions,
  script: (rec: Recorder) => Promise<void>,
): Promise<Sequence> {
  const fps = opts.fps ?? 60;
  const dt = 1000 / fps;
  const format = opts.format ?? "jpeg";
  const ext = format === "jpeg" ? "jpg" : "png";
  const quality = opts.quality ?? 92;
  const st = {
    timeoutMs: opts.settle?.timeoutMs ?? 30_000,
    staleRequestMs: opts.settle?.staleRequestMs ?? 8_000,
    replyMs: opts.settle?.replyMs ?? 1_500,
    quietMs: opts.settle?.quietMs ?? 80,
  };
  const vp = page.viewportSize();
  if (!vp) throw new Error("record: the page has no fixed viewport");
  mkdirSync(opts.dir, { recursive: true });

  const installed = await page.evaluate(() => window.__filmClock !== undefined);
  if (!installed)
    throw new Error(
      "record: the page has no virtual clock — call installRecorderClock(context) before it loads",
    );

  // HTTP in flight, as the browser sees it (the page's own fetches, scripts, images).
  const inflight = new Map<Request, number>();
  const stale = new Set<string>();
  const onReq = (r: Request): void => {
    inflight.set(r, Date.now());
  };
  const onDone = (r: Request): void => {
    inflight.delete(r);
  };
  page.on("request", onReq);
  page.on("requestfinished", onDone);
  page.on("requestfailed", onDone);

  const busy = (): Promise<ClockBusy> =>
    page.evaluate(() => {
      const c = window.__filmClock;
      if (!c)
        throw new Error(
          "record: the virtual clock is gone (the page reloaded?)",
        );
      return c.busy();
    });

  /** Wait, clock frozen, until the page has nothing in flight and has stopped changing. */
  const settle = async (): Promise<void> => {
    const t0 = Date.now();
    let waited = false;
    for (;;) {
      const now = Date.now();
      const reqs: string[] = [];
      for (const [r, since] of inflight) {
        if (now - since < st.staleRequestMs) reqs.push(r.url());
        else if (!stale.has(r.url())) {
          stale.add(r.url());
          console.log(`  record: no longer waiting on long-lived ${r.url()}`);
        }
      }
      const b = await busy();
      const why: string[] = [];
      if (reqs.length)
        why.push(`${reqs.length} request(s): ${reqs.slice(0, 3).join(", ")}`);
      if (b.awaitingReplyMs !== null && b.awaitingReplyMs < st.replyMs)
        why.push("a message awaiting its reply");
      if (b.images) why.push(`${b.images} image(s) loading`);
      if (b.fontsLoading) why.push("fonts loading");
      // A reply may come in several messages: after a recent send, wait until they stop.
      if (
        (waited || b.sinceSendMs < st.replyMs) &&
        b.sinceReceiveMs < st.quietMs
      )
        why.push("messages arriving");
      if (waited && b.sinceMutationMs < st.quietMs) why.push("DOM changing");
      if (why.length === 0) return;
      waited = true;
      if (now - t0 > st.timeoutMs)
        throw new Error(
          `record: frame ${frameNo} did not settle in ${st.timeoutMs} ms: ${why.join("; ")}`,
        );
      await sleep(10);
    }
  };

  const log: InputLog = { cursor: [], clicks: [], keys: [], marks: {} };
  const frames: string[] = [];
  let frameNo = 0;
  let cx = opts.cursor?.x ?? vp.width / 2;
  let cy = opts.cursor?.y ?? vp.height / 2;
  const tNow = (): number => frameNo / fps;
  /** The page-clock rate (see `clockRate`): now, and a ramp towards a target. */
  let rate = 1;
  let rateRamp: {
    from: number;
    to: number;
    frames: number;
    done: number;
  } | null = null;
  /** The rate the next frame steps the page clock at (advancing a ramp). */
  const nextRate = (): number => {
    if (rateRamp) {
      rateRamp.done++;
      const k = Math.min(1, rateRamp.done / rateRamp.frames);
      rate =
        rateRamp.from + (rateRamp.to - rateRamp.from) * ease("inOutSine", k);
      if (k >= 1) rateRamp = null;
    }
    return rate;
  };

  /** Real ms spent per phase, for the closing log line. */
  const spent = { settle: 0, step: 0, shot: 0 };
  /** Every frame's real ms per phase, written as `<name>.timing.json` (also when the recording fails). */
  const timing: FrameTiming[] = [];
  let cur: FrameTiming = { settle: 0, step: 0, shot: 0 };
  const timed = async <T>(
    k: keyof typeof spent,
    f: () => Promise<T>,
  ): Promise<T> => {
    const t0 = Date.now();
    // A phase that runs long is reported while it runs, with its duration, so a
    // stall is visible as one (and how long it lasted) rather than as silence.
    const watch = setInterval(() => {
      console.log(
        `  record: frame ${frameNo} ${k} still running after ${((Date.now() - t0) / 1000).toFixed(0)} s`,
      );
    }, SLOW_PHASE_MS);
    try {
      return await f();
    } finally {
      clearInterval(watch);
      const ms = Date.now() - t0;
      spent[k] += ms;
      cur[k] += ms;
      if (ms >= SLOW_PHASE_MS)
        console.log(`  record: frame ${frameNo} ${k} took ${ms} ms`);
    }
  };

  /** Runs at the start of every frame (a scroll watch), or nothing. */
  let frameHook: (() => Promise<void>) | null = null;

  const capture = async (): Promise<void> => {
    if (frameHook) await timed("step", frameHook);
    await timed("settle", settle);
    if (frameNo > 0) {
      const ms = dt * nextRate();
      await timed("step", () =>
        page.evaluate((ms) => window.__filmClock?.step(ms), ms),
      );
    }
    await timed("settle", settle);
    await timed("step", () => page.evaluate(() => window.__filmClock?.flush()));
    const file = `${opts.name}-${String(frameNo).padStart(5, "0")}.${ext}`;
    const buf = await timed("shot", () =>
      page.screenshot({
        type: format,
        ...(format === "jpeg" ? { quality } : {}),
        // The page's own caret and animations are the film's: Playwright must not touch them.
        caret: "initial",
        animations: "allow",
        scale: "device",
      }),
    );
    writeFileSync(join(opts.dir, file), buf);
    timing.push(cur);
    cur = { settle: 0, step: 0, shot: 0 };
    frames.push(file);
    log.cursor.push([tNow(), round(cx), round(cy)]);
    frameNo++;
    if (frameNo % 60 === 0)
      console.log(`  record: ${(frameNo / fps).toFixed(1)} s`);
  };

  const pointOf = async (
    target: RecTarget,
  ): Promise<{ x: number; y: number }> => {
    if (isPoint(target)) return { x: target.x, y: target.y };
    const withAt = "element" in target && "at" in target;
    const loc = withAt ? target.element : (target as Locator);
    const at = withAt ? target.at : { x: 0.5, y: 0.5 };
    // Not on the page yet (a popover still opening): it can only appear as
    // the page's clock runs, so wait for it frame by frame — a plain
    // Playwright wait would hold the clock still and time out.
    // A box too: an element re-rendered between the two reads (a list
    // re-keyed as its data lands) is visible, then gone for a moment.
    let box: Awaited<ReturnType<Locator["boundingBox"]>> = null;
    for (let i = 0; ; i++) {
      if (await loc.isVisible())
        box = (await loc.boundingBox()) ?? (await contentsBox(loc));
      if (box) break;
      if (i >= APPEAR_FRAMES)
        throw new Error(
          `record: ${String(loc)} did not appear within ${APPEAR_FRAMES / fps} s`,
        );
      await capture();
    }
    const p = { x: box.x + box.width * at.x, y: box.y + box.height * at.y };
    if (p.x < 0 || p.y < 0 || p.x > vp.width || p.y > vp.height)
      throw new Error(
        `record: ${String(loc)} is outside the viewport (${Math.round(p.x)}, ${Math.round(p.y)})`,
      );
    return p;
  };

  /** Frames that show `seconds` of page time at the current clock rate. */
  const framesFor = (seconds: number): number =>
    Math.max(1, Math.round((seconds * fps) / rate));

  /** Put the pointer on `target` where it is now (an element may have moved since the last frame). */
  const aim = async (target: RecTarget): Promise<void> => {
    if (isPoint(target)) return;
    const p = await pointOf(target);
    if (Math.abs(p.x - cx) < 0.5 && Math.abs(p.y - cy) < 0.5) return;
    cx = p.x;
    cy = p.y;
    await page.mouse.move(cx, cy);
  };

  const rec: Recorder = {
    page,
    get t() {
      return tNow();
    },
    get cursor() {
      return { x: cx, y: cy };
    },
    async hold(seconds) {
      const n = Math.round((seconds * fps) / rate);
      for (let i = 0; i < n; i++) await capture();
    },
    clockRate(to, o = {}) {
      if (!(to > 0) || to > 4)
        throw new Error(`record: clockRate(${to}): a rate in (0, 4]`);
      const frames = Math.round((o.over ?? 0) * fps);
      if (frames <= 0) {
        rate = to;
        rateRamp = null;
      } else rateRamp = { from: rate, to, frames, done: 0 };
      (log.rate ??= []).push([tNow(), to]);
    },
    async move(target, o = {}) {
      // An element target is re-aimed every frame: the page keeps moving
      // while the hand travels (a popover sliding into place, a bar
      // collapsing), and a hand follows what it reaches for. Aimed once, the
      // pointer lands where the element WAS — outside a popover that has
      // since moved on, which dismisses it.
      const tracked = !isPoint(target);
      let to = await pointOf(target);
      const fx = cx;
      const fy = cy;
      const via = o.via ?? [];
      assertOneGesture([{ x: fx, y: fy }, ...via, to]);
      // The path's length (through its waypoints): what sets its duration.
      const legs = [{ x: fx, y: fy }, ...via, to];
      let dist = 0;
      for (let i = 1; i < legs.length; i++)
        dist += Math.hypot(
          legs[i]!.x - legs[i - 1]!.x,
          legs[i]!.y - legs[i - 1]!.y,
        );
      if (dist < 0.5 && !tracked) return;
      const duration =
        o.duration ?? Math.min(1.1, Math.max(0.35, 0.4 + dist / 2200));
      const n = dist < 0.5 ? 0 : framesFor(duration);
      for (let i = 1; i <= n; i++) {
        if (tracked && i > 1) to = await pointOf(target);
        const profile = o.profile ?? "ease";
        const u = progressAt(profile, i / n);
        const p =
          via.length > 0
            ? pathAt([{ x: fx, y: fy }, ...via, to], u)
            : bowed({ x: fx, y: fy }, to, u, o.arc ?? 0.06);
        if (profile === "performed" && dist >= 0.5) {
          // Sideways to the straight line from start to target.
          const w = waver(i / n, dist);
          p.x += (-(to.y - fy) / dist) * w;
          p.y += ((to.x - fx) / dist) * w;
        }
        cx = p.x;
        cy = p.y;
        await page.mouse.move(cx, cy);
        await capture();
      }
    },
    async click(target, o = {}) {
      await rec.move(target, { duration: o.duration, via: o.via });
      // The beat before the press, still on target if it moves.
      const dwell = Math.round(((o.dwell ?? 0.12) * fps) / rate);
      for (let i = 0; i < dwell; i++) {
        await aim(target);
        await capture();
      }
      await aim(target);
      const t = tNow();
      await page.mouse.down();
      const n = framesFor(o.press ?? 0.07);
      for (let i = 0; i < n; i++) await capture();
      const upAt = tNow();
      await page.mouse.up();
      log.clicks.push({ t, upAt, x: round(cx), y: round(cy) });
      await capture();
    },
    async type(text, o = {}) {
      const cps = o.cps ?? 14;
      const jitter = o.jitter ?? 0.35;
      const rand = rng(o.seed ?? text.length * 7919);
      let at = tNow();
      for (const ch of Array.from(text)) {
        // Wait (capturing) until this character's moment, then type it.
        while (tNow() < at) await capture();
        const t = tNow();
        if (ch === "\n") {
          await page.keyboard.press("Enter");
          log.keys.push({ t, key: "Enter" });
        } else {
          await page.keyboard.type(ch);
          log.keys.push({ t, key: ch, text: ch });
        }
        const gap = (1 / cps) * (1 + jitter * (rand() * 2 - 1));
        at = t + (ch === " " ? gap * 1.3 : gap);
      }
      await capture();
    },
    async press(key) {
      log.keys.push({ t: tNow(), key });
      await page.keyboard.press(key);
      await capture();
    },
    async drag(from, to, o = {}) {
      await rec.move(from);
      await rec.hold(0.1);
      const t = tNow();
      await page.mouse.down();
      await rec.move(to, {
        duration: o.duration ?? 0.8,
        arc: 0.02,
        profile: o.profile,
      });
      await rec.hold(0.05);
      const upAt = tNow();
      await page.mouse.up();
      log.clicks.push({ t, upAt, x: round(cx), y: round(cy) });
      await capture();
    },
    async wheel(dy, o = {}) {
      const room = await page.evaluate(
        ([x, y, down]) => {
          let el: Element | null = document.elementFromPoint(x, y);
          for (; el; el = el.parentElement) {
            const st = getComputedStyle(el);
            if (
              el.scrollHeight > el.clientHeight + 1 &&
              (st.overflowY === "auto" || st.overflowY === "scroll")
            )
              break;
          }
          const s = el ?? document.scrollingElement;
          if (!s) return null;
          return down
            ? s.scrollHeight - s.clientHeight - s.scrollTop
            : s.scrollTop;
        },
        [cx, cy, dy > 0] as const,
      );
      if (room === null)
        throw new Error(
          `record: wheel(${dy}): nothing scrolls under the pointer`,
        );
      if (Math.abs(dy) > room + 1)
        throw new Error(
          `record: wheel(${dy}) would overscroll: the scroller under the pointer has ${Math.round(room)} px left that way (it would bounce)`,
        );
      const n = framesFor(o.duration ?? 0.6);
      let done = 0;
      for (let i = 1; i <= n; i++) {
        const next = Math.round(dy * ease("inOutSine", i / n));
        await page.mouse.wheel(0, next - done);
        done = next;
        await capture();
      }
    },
    async scrollTo(within, top, o = {}) {
      const read = () =>
        within.evaluate((el) => {
          let s: HTMLElement | null = el.parentElement;
          for (; s; s = s.parentElement) {
            const st = getComputedStyle(s);
            if (
              s.scrollHeight > s.clientHeight + 1 &&
              (st.overflowY === "auto" || st.overflowY === "scroll")
            )
              break;
          }
          if (!s) return null;
          return {
            top: s.scrollTop,
            max: s.scrollHeight - s.clientHeight,
          };
        });
      const set = (y: number) =>
        within.evaluate((el, to) => {
          let s: HTMLElement | null = el.parentElement;
          for (; s; s = s.parentElement) {
            const st = getComputedStyle(s);
            if (
              s.scrollHeight > s.clientHeight + 1 &&
              (st.overflowY === "auto" || st.overflowY === "scroll")
            )
              break;
          }
          s!.scrollTo({ top: to, behavior: "instant" });
          return { top: s!.scrollTop, max: s!.scrollHeight - s!.clientHeight };
        }, y);
      const from = await read();
      if (!from)
        throw new Error(
          `record: scrollTo: ${String(within)} is in no scroller`,
        );
      const n = framesFor(o.duration ?? 0.7);
      for (let i = 1; i <= n; i++) {
        const want =
          from.top + (top - from.top) * ease(o.easing ?? "inOutQuad", i / n);
        const got = await set(want);
        // The scroller rounds to device pixels; anything more is the end.
        if (Math.abs(got.top - want) > 1)
          throw new Error(
            `record: scrollTo(${Math.round(top)}) would overscroll: at frame ${i}/${n} the scroller reaches ${Math.round(got.max)}, the move wants ${Math.round(want)} (it would bounce)`,
          );
        await capture();
      }
    },
    watchScroll(within) {
      if (frameHook)
        throw new Error("record: watchScroll while one is running");
      const scroll = (log.scroll ??= []);
      frameHook = async () => {
        const top = await within.evaluate((el) => {
          let s: HTMLElement | null = el.parentElement;
          for (; s; s = s.parentElement) {
            const st = getComputedStyle(s);
            if (
              s.scrollHeight > s.clientHeight + 1 &&
              (st.overflowY === "auto" || st.overflowY === "scroll")
            )
              break;
          }
          return s?.scrollTop ?? null;
        });
        if (top !== null) scroll.push([tNow(), round(top)]);
      };
      return {
        stop() {
          frameHook = null;
        },
      };
    },
    async settledRect(target) {
      const r = await target.evaluate((el) => {
        const anims = document
          .getAnimations()
          .filter((a) => a.timeline === document.timeline);
        const was = anims.map((a) => a.currentTime);
        for (const a of anims) {
          const end = a.effect?.getComputedTiming().endTime;
          if (typeof end === "number" && Number.isFinite(end))
            a.currentTime = end;
        }
        let s: HTMLElement | null = el.parentElement;
        for (; s; s = s.parentElement) {
          const st = getComputedStyle(s);
          if (
            s.scrollHeight > s.clientHeight + 1 &&
            (st.overflowY === "auto" || st.overflowY === "scroll")
          )
            break;
        }
        const b = el.getBoundingClientRect();
        const v = s?.getBoundingClientRect();
        const out = {
          x: b.x,
          y: b.y,
          width: b.width,
          height: b.height,
          scroller:
            s && v
              ? {
                  top: v.top,
                  height: s.clientHeight,
                  scrollTop: s.scrollTop,
                  maxScrollTop: s.scrollHeight - s.clientHeight,
                }
              : null,
        };
        anims.forEach((a, i) => {
          a.currentTime = was[i] ?? null;
        });
        return out;
      });
      if (!r.scroller)
        throw new Error(
          `record: settledRect: ${String(target)} is in no scroller`,
        );
      return { ...r, scroller: r.scroller };
    },
    async mark(name, target) {
      if (log.marks[name]) throw new Error(`record: mark "${name}" twice`);
      let rect: Rect | undefined;
      if (target && !("boundingBox" in target)) {
        rect = {
          x: round(target.x),
          y: round(target.y),
          width: round(target.width),
          height: round(target.height),
        };
      } else if (target) {
        const b = (await target.boundingBox()) ?? (await contentsBox(target));
        if (!b)
          throw new Error(
            `record: mark "${name}": ${String(target)} is not on the page`,
          );
        rect = {
          x: round(b.x),
          y: round(b.y),
          width: round(b.width),
          height: round(b.height),
        };
      }
      log.marks[name] = { t: tNow(), ...(rect ? { rect } : {}) };
    },
  };

  const started = Date.now();
  try {
    await page.mouse.move(cx, cy);
    await settle();
    await page.evaluate(() => window.__filmClock?.start());
    await script(rec);
  } finally {
    writeFileSync(
      join(opts.dir, `${opts.name}.timing.json`),
      JSON.stringify({ frames: timing, failedFrame: cur }),
    );
    page.off("request", onReq);
    page.off("requestfinished", onDone);
    page.off("requestfailed", onDone);
  }
  if (frames.length === 0)
    throw new Error("record: the script captured no frame");
  const seq: Sequence = {
    frames,
    clip: { x: 0, y: 0, width: vp.width, height: vp.height },
    fps,
    input: log,
  };
  writeFileSync(
    join(opts.dir, `${opts.name}.json`),
    JSON.stringify(seq, null, 1),
  );
  const secs = (Date.now() - started) / 1000;
  const shots = timing.map((f) => f.shot).sort((a, b) => a - b);
  const pct = (q: number): number =>
    shots[Math.min(shots.length - 1, Math.floor(q * shots.length))] ?? 0;
  console.log(
    `record: ${frames.length} frames (${(frames.length / fps).toFixed(2)} s) in ${secs.toFixed(0)} s real, ${((secs / frames.length) * 1000).toFixed(0)} ms/frame (settle ${(spent.settle / frames.length).toFixed(0)}, step ${(spent.step / frames.length).toFixed(0)}, screenshot ${(spent.shot / frames.length).toFixed(0)}; screenshot p50 ${pct(0.5)}, p99 ${pct(0.99)}, max ${pct(1)}) → ${opts.dir}`,
  );
  return seq;
}

/** A screen point, not an element. A Locator has methods named like neither key, so plain-object keys tell the three apart. */
function isPoint(target: RecTarget): target is { x: number; y: number } {
  return "x" in target && typeof target.x === "number";
}

/**
 * The box a `display: contents` element draws through its children (it has
 * none of its own, so Playwright's boundingBox is null): the union of their
 * client rects — what a person sees and points at. Null for any other
 * element, or one whose children draw nothing.
 */
async function contentsBox(
  loc: Locator,
): Promise<{ x: number; y: number; width: number; height: number } | null> {
  return loc.evaluate((el) => {
    if (getComputedStyle(el).display !== "contents") return null;
    let l = Infinity;
    let t = Infinity;
    let r = -Infinity;
    let b = -Infinity;
    const range = document.createRange();
    range.selectNodeContents(el);
    for (const q of Array.from(range.getClientRects())) {
      if (q.width === 0 && q.height === 0) continue;
      l = Math.min(l, q.left);
      t = Math.min(t, q.top);
      r = Math.max(r, q.right);
      b = Math.max(b, q.bottom);
    }
    return Number.isFinite(l)
      ? { x: l, y: t, width: r - l, height: b - t }
      : null;
  });
}

/** Real ms one frame spent in each phase. */
interface FrameTiming {
  settle: number;
  step: number;
  shot: number;
}

/** How many frames a move / click waits for its element target to appear. */
const APPEAR_FRAMES = 300;

/** A phase running at least this long (real ms) is logged, while it runs and when it ends. */
const SLOW_PHASE_MS = 5_000;

const round = (n: number): number => Math.round(n * 100) / 100;

interface Point {
  x: number;
  y: number;
}

/**
 * The sharpest turn a path through waypoints may take at one (degrees). A
 * sharper one is two gestures — a dive and a turn back at speed (the promo
 * film's hand dove to a frame's middle and ricocheted off it) — however
 * smooth the curve drawn through it.
 */
const MAX_VIA_TURN_DEG = 75;

function assertOneGesture(pts: readonly Point[]): void {
  for (let i = 1; i < pts.length - 1; i++) {
    const a = { x: pts[i]!.x - pts[i - 1]!.x, y: pts[i]!.y - pts[i - 1]!.y };
    const b = { x: pts[i + 1]!.x - pts[i]!.x, y: pts[i + 1]!.y - pts[i]!.y };
    const na = Math.hypot(a.x, a.y);
    const nb = Math.hypot(b.x, b.y);
    if (na < 1 || nb < 1) continue;
    const turn =
      (Math.acos(
        Math.max(-1, Math.min(1, (a.x * b.x + a.y * b.y) / (na * nb))),
      ) *
        180) /
      Math.PI;
    if (turn > MAX_VIA_TURN_DEG)
      throw new Error(
        `record: a move turns ${Math.round(turn)}° at its waypoint (${Math.round(pts[i]!.x)}, ${Math.round(pts[i]!.y)}) — over ${MAX_VIA_TURN_DEG}° it is two gestures, not one: move the waypoint onto the way`,
      );
  }
}

/** A straight move bowed a little along its normal (most mid-way), at progress `u`. */
function bowed(from: Point, to: Point, u: number, arc: number): Point {
  const dist = Math.hypot(to.x - from.x, to.y - from.y);
  if (dist < 0.5) return { x: to.x, y: to.y };
  const b = Math.sin(Math.PI * u) * arc * dist;
  const nx = -(to.y - from.y) / dist;
  const ny = (to.x - from.x) / dist;
  return {
    x: from.x + (to.x - from.x) * u + nx * b,
    y: from.y + (to.y - from.y) * u + ny * b,
  };
}

/**
 * The point at progress `u` (0..1, by arc length) along a smooth curve
 * through `pts` (Catmull-Rom, centripetal enough for a hand's path): one
 * path, so one ease over it reads as one gesture.
 */
function pathAt(pts: readonly Point[], u: number): Point {
  const seg = (a: Point, b: Point, c: Point, d: Point, t: number): Point => {
    const t2 = t * t;
    const t3 = t2 * t;
    const f = (p0: number, p1: number, p2: number, p3: number) =>
      0.5 *
      (2 * p1 +
        (-p0 + p2) * t +
        (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 +
        (-p0 + 3 * p1 - 3 * p2 + p3) * t3);
    return { x: f(a.x, b.x, c.x, d.x), y: f(a.y, b.y, c.y, d.y) };
  };
  // Sample the curve densely, then walk it by arc length.
  const samples: Point[] = [];
  const S = 24;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[Math.max(0, i - 1)]!;
    const b = pts[i]!;
    const c = pts[i + 1]!;
    const d = pts[Math.min(pts.length - 1, i + 2)]!;
    for (let k = 0; k < S; k++) samples.push(seg(a, b, c, d, k / S));
  }
  samples.push(pts[pts.length - 1]!);
  const acc = [0];
  for (let i = 1; i < samples.length; i++)
    acc.push(
      acc[i - 1]! +
        Math.hypot(
          samples[i]!.x - samples[i - 1]!.x,
          samples[i]!.y - samples[i - 1]!.y,
        ),
    );
  const total = acc[acc.length - 1]!;
  const want = Math.min(1, Math.max(0, u)) * total;
  let j = 1;
  while (j < acc.length - 1 && acc[j]! < want) j++;
  const span = acc[j]! - acc[j - 1]! || 1;
  const k = (want - acc[j - 1]!) / span;
  return {
    x: samples[j - 1]!.x + (samples[j]!.x - samples[j - 1]!.x) * k,
    y: samples[j - 1]!.y + (samples[j]!.y - samples[j - 1]!.y) * k,
  };
}
