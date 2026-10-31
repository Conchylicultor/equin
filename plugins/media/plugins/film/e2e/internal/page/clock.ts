// The virtual clock a recorded page runs on (see ../record.ts). Installed as an
// init script, so it is in place before any page script reads the time.
//
// Two modes:
// - `real` (until `start()`): the page runs at wall-clock speed — it boots,
//   fetches, renders like any page. Every timer and rAF still goes through the
//   wrappers below, so the switch can take them over.
// - `virtual` (from `start()`): time stands still. `performance.now`, `Date`,
//   timers and rAF only move when the recorder calls `step(ms)`; CSS
//   transitions, CSS animations and WAAPI animations are paused and scrubbed to
//   the virtual time (the timesnap technique). Network, microtasks and
//   MessageChannel tasks still run in real time — so data the app fetches
//   while the clock stands still lands "instantly", in the frame being drawn.
//
// The page also tracks what it is still waiting for (`busy()`): a message sent
// to a socket or worker port with no reply yet, images not decoded, fonts
// loading, the DOM still changing — the recorder waits on it, clock frozen,
// before it captures a frame.

export interface ClockBusy {
  /** Messages sent to a WebSocket / worker port with no message back since (and how long ago, real ms). */
  awaitingReplyMs: number | null;
  /** Real ms since the page last sent a message on an instrumented channel. */
  sinceSendMs: number;
  /** Real ms since the last message received on any instrumented channel. */
  sinceReceiveMs: number;
  /** Images intersecting the viewport that have not finished loading. */
  images: number;
  fontsLoading: boolean;
  /** Real ms since the last DOM mutation. */
  sinceMutationMs: number;
}

export interface FilmClockApi {
  /** Switch to virtual time; time stands still from here. */
  start(): void;
  /** Advance virtual time by `ms`: fire due timers in order, then one rAF turn, then scrub every animation. */
  step(ms: number): void;
  /** Scrub every animation to the current virtual time (new ones are born now). Then wait two real frames. */
  flush(): Promise<void>;
  busy(): ClockBusy;
  /** Virtual ms since `start()`. */
  elapsed(): number;
  virtual(): boolean;
}

declare global {
  interface Window {
    __filmClock?: FilmClockApi;
  }
}

type Cb = (...args: unknown[]) => void;

interface Timer {
  id: number;
  cb: Cb;
  args: unknown[];
  due: number;
  interval: number | null;
  /** How many timer callbacks deep it was set (the HTML spec's nesting level). */
  nesting: number;
  native: number | null;
}

interface Scrub {
  born: number;
  done: boolean;
  /** The app paused it itself before we saw it: left alone. */
  foreign: boolean;
}

export function installClock(): void {
  if (window.__filmClock) return;
  const w = window as unknown as Record<string, unknown>;
  const N = {
    setTimeout: window.setTimeout.bind(window),
    clearTimeout: window.clearTimeout.bind(window),
    raf: window.requestAnimationFrame.bind(window),
    caf: window.cancelAnimationFrame.bind(window),
    perfNow: performance.now.bind(performance),
    Date: window.Date,
    dateNow: window.Date.now.bind(window.Date),
  };
  const report = (err: unknown): void => {
    // As a native timer would: the error reaches window.onerror / pageerror,
    // and the loop that ran the callback goes on.
    window.reportError(err);
  };

  let isVirtual = false;
  let vt = 0;
  let startVt = 0;
  /** True only inside start(): animations seen then were running before it. */
  let starting = false;
  const clock = (): number => (isVirtual ? vt : N.perfNow());
  const dateBase = N.dateNow() - N.perfNow();
  const dateNow = (): number => Math.floor(dateBase + clock());

  // ------------------------------------------------------------- time ----
  Object.defineProperty(performance, "now", {
    value: clock,
    configurable: true,
    writable: true,
  });
  Object.defineProperty(N.Date, "now", {
    value: dateNow,
    configurable: true,
    writable: true,
  });
  // A Proxy, not a subclass: Date.prototype stays the native one, so a Date
  // from anywhere (structuredClone, IndexedDB) is still `instanceof Date`.
  w.Date = new Proxy(N.Date, {
    construct(target, args: unknown[], newTarget) {
      return Reflect.construct(
        target,
        args.length === 0 ? [dateNow()] : args,
        newTarget as typeof N.Date,
      ) as object;
    },
    apply() {
      return new N.Date(dateNow()).toString();
    },
  });

  // ------------------------------------------------------ audio clock ----
  // A player whose playhead follows `AudioContext.currentTime` (a sequencer,
  // a piano roll) must move with the page's time, not the sound card's: in
  // virtual mode a running context's time advances by exactly the virtual
  // time stepped since the clock took it over, and stands still while the
  // context is suspended. (What reaches the speakers is not the film's: a
  // recording captures pictures, and a film places the sound itself.)
  const ctTime = Object.getOwnPropertyDescriptor(
    BaseAudioContext.prototype,
    "currentTime",
  )?.get;
  if (ctTime) {
    const anchors = new WeakMap<
      BaseAudioContext,
      { base: number; at: number; frozen: number | null }
    >();
    Object.defineProperty(BaseAudioContext.prototype, "currentTime", {
      configurable: true,
      get(this: BaseAudioContext): number {
        const real = ctTime.call(this) as number;
        // An offline context renders as fast as it can: its time is its own.
        if (!isVirtual || !(this instanceof AudioContext)) return real;
        let a = anchors.get(this);
        if (!a) {
          a = { base: real, at: vt, frozen: null };
          anchors.set(this, a);
        }
        if (this.state !== "running") {
          a.frozen ??= a.base + (vt - a.at) / 1000;
          return a.frozen;
        }
        if (a.frozen !== null) {
          a.base = a.frozen;
          a.at = vt;
          a.frozen = null;
        }
        return a.base + (vt - a.at) / 1000;
      },
    });
  }

  // ----------------------------------------------------------- timers ----
  const timers = new Map<number, Timer>();
  let nextId = 1;
  /** Nesting level of the timer callback running now (0: none). */
  let running = 0;
  const arm = (t: Timer): void => {
    if (isVirtual) return;
    t.native = N.setTimeout(() => fire(t), Math.max(0, t.due - clock()));
  };
  const fire = (t: Timer): void => {
    if (timers.get(t.id) !== t) return;
    t.native = null;
    if (t.interval === null) timers.delete(t.id);
    else t.due += t.interval;
    const outer = running;
    running = t.nesting;
    try {
      t.cb(...t.args);
    } catch (err) {
      report(err);
    } finally {
      running = outer;
    }
    if (t.interval !== null && timers.get(t.id) === t) arm(t);
  };
  const schedule = (
    cb: unknown,
    delay: unknown,
    args: unknown[],
    repeat: boolean,
  ): number => {
    const fn: Cb =
      typeof cb === "function"
        ? (cb as Cb)
        : () => {
            throw new Error(
              "film clock: string timer callbacks are not supported",
            );
          };
    const nesting = running + 1;
    // As browsers do: past 5 nested levels a timer waits at least 4 ms, so a
    // self-rescheduling 0 ms timer cannot spin a step forever.
    const d = Math.max(nesting > 5 ? 4 : 0, Number(delay) || 0);
    const t: Timer = {
      id: nextId++,
      cb: fn,
      args,
      due: clock() + d,
      // Browsers clamp a repeating 0 ms interval; so do we, or a step would spin.
      interval: repeat ? Math.max(1, d) : null,
      nesting,
      native: null,
    };
    timers.set(t.id, t);
    arm(t);
    return t.id;
  };
  const clear = (id: unknown): void => {
    const t = timers.get(Number(id));
    if (!t) return;
    if (t.native !== null) N.clearTimeout(t.native);
    timers.delete(t.id);
  };
  w.setTimeout = (cb: unknown, delay?: unknown, ...args: unknown[]) =>
    schedule(cb, delay, args, false);
  w.setInterval = (cb: unknown, delay?: unknown, ...args: unknown[]) =>
    schedule(cb, delay, args, true);
  w.clearTimeout = clear;
  w.clearInterval = clear;

  // -------------------------------------------------------------- rAF ----
  const rafs = new Map<number, FrameRequestCallback>();
  const nativeRafs = new Map<number, { h: number; cb: FrameRequestCallback }>();
  w.requestAnimationFrame = (cb: FrameRequestCallback): number => {
    const id = nextId++;
    if (isVirtual) rafs.set(id, cb);
    else {
      const h = N.raf((ts) => {
        nativeRafs.delete(id);
        cb(ts);
      });
      nativeRafs.set(id, { h, cb });
    }
    return id;
  };
  w.cancelAnimationFrame = (id: number): void => {
    rafs.delete(id);
    const n = nativeRafs.get(id);
    if (n) {
      N.caf(n.h);
      nativeRafs.delete(id);
    }
  };

  // ------------------------------------------------------- animations ----
  const scrubs = new WeakMap<Animation, Scrub>();
  const syncAnimations = (): void => {
    for (const a of document.getAnimations()) {
      let s = scrubs.get(a);
      if (!s) {
        const rate = a.playbackRate || 1;
        // Running before start(): keep its phase. Born while the clock stood
        // still: it starts now, whatever real time passed since it was made.
        const pre = starting && a.playState === "running";
        const ct = typeof a.currentTime === "number" ? a.currentTime : 0;
        s = {
          born: pre ? vt - ct / rate : vt,
          done: false,
          foreign: a.playState === "paused",
        };
        scrubs.set(a, s);
      }
      if (s.done || s.foreign || !a.effect) continue;
      if (a.playState !== "paused") a.pause();
      const elapsed = (vt - s.born) * (a.playbackRate || 1);
      const end = Number(a.effect.getComputedTiming().endTime ?? Infinity);
      if (Number.isFinite(end) && elapsed >= end) {
        // A paused animation never finishes on its own: finish it, so its
        // `finished` promise, finish event and transitionend still come.
        s.done = true;
        a.finish();
      } else a.currentTime = elapsed;
    }
  };

  // element.animate(): paused the moment it exists, born at the current virtual time.
  const nativeAnimate = Element.prototype.animate;
  Element.prototype.animate = function (
    this: Element,
    ...a: Parameters<Element["animate"]>
  ): Animation {
    const anim = nativeAnimate.apply(this, a);
    if (isVirtual) syncAnimations();
    return anim;
  };

  // ------------------------------------------------------- busy state ----
  let lastSend = -Infinity;
  let lastRecv = -Infinity;
  let lastMutation = N.perfNow();
  const onRecv = (): void => {
    lastRecv = N.perfNow();
  };
  const onSend = (): void => {
    lastSend = N.perfNow();
  };
  const NativeWS = window.WebSocket;
  const wsSend = NativeWS.prototype.send;
  NativeWS.prototype.send = function (
    this: WebSocket,
    ...a: Parameters<WebSocket["send"]>
  ) {
    onSend();
    return wsSend.apply(this, a);
  };
  w.WebSocket = new Proxy(NativeWS, {
    construct(target, args: unknown[], nt) {
      const s = Reflect.construct(target, args, nt) as WebSocket;
      s.addEventListener("message", onRecv);
      return s;
    },
  });
  /** A worker's port: what the page sends it and what comes back are channel traffic. */
  const watchPort = (port: MessagePort | Worker): void => {
    port.addEventListener("message", onRecv);
    const post = port.postMessage.bind(port) as (...a: unknown[]) => void;
    (
      port as unknown as { postMessage: (...a: unknown[]) => void }
    ).postMessage = (...a: unknown[]) => {
      onSend();
      post(...a);
    };
  };
  if (typeof window.SharedWorker === "function") {
    w.SharedWorker = new Proxy(window.SharedWorker, {
      construct(target, args: unknown[], nt) {
        const sw = Reflect.construct(target, args, nt) as SharedWorker;
        watchPort(sw.port);
        return sw;
      },
    });
  }
  w.Worker = new Proxy(window.Worker, {
    construct(target, args: unknown[], nt) {
      const wk = Reflect.construct(target, args, nt) as Worker;
      watchPort(wk);
      return wk;
    },
  });
  const observe = (): void => {
    new MutationObserver(() => {
      lastMutation = N.perfNow();
      // A DOM change can start a CSS transition / animation; getAnimations()
      // creates it now (it flushes style), so it is paused before the real
      // timeline can run it while the recorder waits.
      if (isVirtual) syncAnimations();
    }).observe(document, {
      subtree: true,
      childList: true,
      attributes: true,
      characterData: true,
    });
  };
  if (document.documentElement) observe();
  else document.addEventListener("readystatechange", observe, { once: true });

  /** Fire every timer due by `target` in due order (each at its own time), then stand at `target`. */
  const runDue = (target: number): void => {
    for (;;) {
      let next: Timer | null = null;
      for (const t of timers.values())
        if (t.due <= target && (next === null || t.due < next.due)) next = t;
      if (next === null) break;
      vt = Math.max(vt, next.due);
      fire(next);
    }
    vt = target;
  };

  const nativeFrame = (): Promise<void> =>
    new Promise((resolve) => N.raf(() => resolve()));

  const api: FilmClockApi = {
    start() {
      if (isVirtual) return;
      vt = clock();
      startVt = vt;
      isVirtual = true;
      for (const t of timers.values()) {
        if (t.native !== null) N.clearTimeout(t.native);
        t.native = null;
      }
      for (const [id, n] of nativeRafs) {
        N.caf(n.h);
        rafs.set(id, n.cb);
      }
      nativeRafs.clear();
      starting = true;
      syncAnimations();
      starting = false;
    },
    step(ms) {
      if (!isVirtual) throw new Error("film clock: step() before start()");
      runDue(vt + ms);
      const due = [...rafs.values()];
      rafs.clear();
      for (const cb of due) {
        try {
          cb(vt);
        } catch (err) {
          report(err);
        }
      }
      syncAnimations();
    },
    async flush() {
      syncAnimations();
      await nativeFrame();
      syncAnimations();
      await nativeFrame();
    },
    busy() {
      // Polled while the recorder waits: catches an animation started by
      // anything else (a hover, a reply) within one poll.
      // A timer set while the clock stood still with no delay (a batch, a
      // deferred subscribe) is due now: it runs, as it would within the frame.
      if (isVirtual) {
        runDue(vt);
        syncAnimations();
      }
      const now = N.perfNow();
      let images = 0;
      for (const img of Array.from(document.images)) {
        if (img.complete) continue;
        const r = img.getBoundingClientRect();
        if (
          r.width > 0 &&
          r.bottom > 0 &&
          r.right > 0 &&
          r.top < innerHeight &&
          r.left < innerWidth
        ) {
          // A lazy image in view starts loading at the browser's next
          // rendering step — which, while the recorder waits for it before
          // capturing, never comes: start it now, as that step would.
          if (img.loading === "lazy") img.loading = "eager";
          images++;
        }
      }
      return {
        awaitingReplyMs: lastSend > lastRecv ? now - lastSend : null,
        sinceSendMs: now - lastSend,
        sinceReceiveMs: now - lastRecv,
        images,
        fontsLoading: document.fonts.status === "loading",
        sinceMutationMs: now - lastMutation,
      };
    },
    elapsed: () => vt - startVt,
    virtual: () => isVirtual,
  };
  window.__filmClock = api;
}
