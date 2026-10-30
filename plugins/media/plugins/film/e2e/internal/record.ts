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
import { ease } from "./easing";
import type { ClockBusy } from "./page/clock";

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
  /** Capture `seconds` of the page doing nothing scripted. */
  hold(seconds: number): Promise<void>;
  /** Glide the pointer to a target (hover states follow it). */
  move(
    target: RecTarget,
    opts?: { duration?: number; arc?: number },
  ): Promise<void>;
  /** Move to a target, rest a beat, press, release. */
  click(
    target: RecTarget,
    opts?: { duration?: number; dwell?: number; press?: number },
  ): Promise<void>;
  /** Type into the focused element, one character at a time at `cps` characters per second (humanly uneven). */
  type(
    text: string,
    opts?: { cps?: number; jitter?: number; seed?: number },
  ): Promise<void>;
  /** Press one key (e.g. "Enter", "Meta+a") in the next frame. */
  press(key: string): Promise<void>;
  /** Press at `from`, move to `to` over `duration`, release. */
  drag(
    from: RecTarget,
    to: RecTarget,
    opts?: { duration?: number },
  ): Promise<void>;
  /** Scroll the element under the pointer by `dy` px over `duration`. */
  wheel(dy: number, opts?: { duration?: number }): Promise<void>;
  /** Name this moment (and the rect of `target`, if given) in the log. */
  mark(name: string, target?: Locator): Promise<void>;
}

/** Install the virtual clock on every page of `context`. Call before the page you record loads. */
export async function installRecorderClock(
  context: BrowserContext,
): Promise<void> {
  await context.addInitScript({
    content: await bundlePageScript("clock-main.ts"),
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

  /** Real ms spent per phase, for the closing log line. */
  const spent = { settle: 0, step: 0, shot: 0 };
  const timed = async <T>(
    k: keyof typeof spent,
    f: () => Promise<T>,
  ): Promise<T> => {
    const t0 = Date.now();
    try {
      return await f();
    } finally {
      spent[k] += Date.now() - t0;
    }
  };

  const capture = async (): Promise<void> => {
    await timed("settle", settle);
    if (frameNo > 0)
      await timed("step", () =>
        page.evaluate((ms) => window.__filmClock?.step(ms), dt),
      );
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
    frames.push(file);
    log.cursor.push([tNow(), round(cx), round(cy)]);
    frameNo++;
    if (frameNo % 60 === 0)
      console.log(`  record: ${(frameNo / fps).toFixed(1)} s`);
  };

  const pointOf = async (
    target: RecTarget,
  ): Promise<{ x: number; y: number }> => {
    // A Locator has methods named like neither key, so plain-object keys tell the three apart.
    if ("x" in target && typeof target.x === "number")
      return { x: target.x, y: target.y };
    const withAt = "element" in target && "at" in target;
    const loc = withAt ? target.element : (target as Locator);
    const at = withAt ? target.at : { x: 0.5, y: 0.5 };
    const box = await loc.boundingBox();
    if (!box) throw new Error(`record: ${String(loc)} is not on the page`);
    const p = { x: box.x + box.width * at.x, y: box.y + box.height * at.y };
    if (p.x < 0 || p.y < 0 || p.x > vp.width || p.y > vp.height)
      throw new Error(
        `record: ${String(loc)} is outside the viewport (${Math.round(p.x)}, ${Math.round(p.y)})`,
      );
    return p;
  };

  const framesFor = (seconds: number): number =>
    Math.max(1, Math.round(seconds * fps));

  const rec: Recorder = {
    page,
    get t() {
      return tNow();
    },
    async hold(seconds) {
      const n = Math.round(seconds * fps);
      for (let i = 0; i < n; i++) await capture();
    },
    async move(target, o = {}) {
      const to = await pointOf(target);
      const fx = cx;
      const fy = cy;
      const dist = Math.hypot(to.x - fx, to.y - fy);
      if (dist < 0.5) return;
      const duration =
        o.duration ?? Math.min(1.1, Math.max(0.35, 0.4 + dist / 2200));
      // A hand's path bows a little: offset along the normal, most mid-way.
      const bow = (o.arc ?? 0.06) * dist;
      const nx = -(to.y - fy) / dist;
      const ny = (to.x - fx) / dist;
      const n = framesFor(duration);
      for (let i = 1; i <= n; i++) {
        const u = ease("inOutCubic", i / n);
        const b = Math.sin(Math.PI * u) * bow;
        cx = fx + (to.x - fx) * u + nx * b;
        cy = fy + (to.y - fy) * u + ny * b;
        await page.mouse.move(cx, cy);
        await capture();
      }
    },
    async click(target, o = {}) {
      await rec.move(target, { duration: o.duration });
      await rec.hold(o.dwell ?? 0.12);
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
      await rec.move(to, { duration: o.duration ?? 0.8, arc: 0.02 });
      await rec.hold(0.05);
      const upAt = tNow();
      await page.mouse.up();
      log.clicks.push({ t, upAt, x: round(cx), y: round(cy) });
      await capture();
    },
    async wheel(dy, o = {}) {
      const n = framesFor(o.duration ?? 0.6);
      let done = 0;
      for (let i = 1; i <= n; i++) {
        const next = Math.round(dy * ease("inOutSine", i / n));
        await page.mouse.wheel(0, next - done);
        done = next;
        await capture();
      }
    },
    async mark(name, target) {
      if (log.marks[name]) throw new Error(`record: mark "${name}" twice`);
      let rect: Rect | undefined;
      if (target) {
        const b = await target.boundingBox();
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
  console.log(
    `record: ${frames.length} frames (${(frames.length / fps).toFixed(2)} s) in ${secs.toFixed(0)} s real, ${((secs / frames.length) * 1000).toFixed(0)} ms/frame (settle ${(spent.settle / frames.length).toFixed(0)}, step ${(spent.step / frames.length).toFixed(0)}, screenshot ${(spent.shot / frames.length).toFixed(0)}) → ${opts.dir}`,
  );
  return seq;
}

const round = (n: number): number => Math.round(n * 100) / 100;
