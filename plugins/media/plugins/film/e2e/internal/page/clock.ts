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

/**
 * The calendar a recorded page is pinned to (`installRecorderClock`'s
 * `date`): it read `epoch` (ms) at the real instant `realAt` (ms), and runs
 * on from there.
 */
export interface FilmDatePin {
  epoch: number;
  realAt: number;
}

declare global {
  interface Window {
    __filmClock?: FilmClockApi;
    __filmDatePin?: FilmDatePin | null;
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

/**
 * The clock's hold on one animation: its playhead, advanced by virtual time
 * while the app means it to run. The app's own play state is the intent —
 * `pause()` / `play()` are the app's to call, the clock only ever pauses an
 * animation to drive it.
 */
interface Scrub {
  /** Its playhead (ms of its own time) at virtual time `at`. */
  pos: number;
  at: number;
  /** The `currentTime` read back after the clock last set it: a different one now is a seek by the app. */
  readBack: number | null;
  done: boolean;
  /** The app paused it (`pause()`, or it was paused when first seen): it stands where the app left it until the app plays it again. */
  appPaused: boolean;
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
  // Date at clock() = 0. Pinned: the pin's instant plus the real time since
  // it was taken (so every load of the context runs on the same calendar).
  const pin = window.__filmDatePin ?? null;
  const dateBase =
    (pin ? pin.epoch + (N.dateNow() - pin.realAt) : N.dateNow()) - N.perfNow();
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
  /**
   * Every animation the clock paused and has not finished yet. A paused
   * animation never finishes on its own, so only the clock can finish it —
   * and `document.getAnimations()` cannot be trusted to keep handing it back:
   * Blink drops an animation it judges past its end (within its time
   * tolerance) when it does not fill forwards. Virtual time is a sum of
   * frame steps (1000/60 ms each), so a transition born on one frame can sit
   * at 149.99999999999 ms of 150 — at its end to Blink (transitionend fires,
   * it leaves getAnimations), short of it to `elapsed >= end` — and stayed
   * paused there forever, its `finished` promise never settling (a
   * floating-action panel waiting on it never revealed; the Wish popover
   * never drew). Held here, it is finished on the next sync.
   */
  const owned = new Set<Animation>();
  // The clock pauses and plays with the native methods; the page's own calls
  // go through the wrappers below, which are how the clock knows the app's
  // intent (a paused animation is paused for the clock either way).
  const nativePause = Animation.prototype.pause;
  const nativePlay = Animation.prototype.play;
  const isNum = (v: unknown): v is number => typeof v === "number";
  const scrubOf = (a: Animation): Scrub => {
    let s = scrubs.get(a);
    if (!s) {
      // Running before start(): keep its phase. Born while the clock stood
      // still: it starts now, whatever real time passed since it was made.
      // Paused when first seen: the app's (or its CSS's) pause, its phase kept.
      const pre = starting && a.playState === "running";
      const paused = a.playState === "paused";
      s = {
        pos: (pre || paused) && isNum(a.currentTime) ? a.currentTime : 0,
        at: vt,
        readBack: null,
        done: false,
        appPaused: paused,
      };
      scrubs.set(a, s);
    }
    return s;
  };
  /** Move a driven animation's playhead to the current virtual time; finish it at its end. */
  const advance = (a: Animation, s: Scrub): void => {
    if (!a.effect) return;
    const rate = a.playbackRate;
    // A seek by the app since the clock last set it: its playhead is that.
    const cur = a.currentTime;
    if (isNum(cur) && s.readBack !== null && Math.abs(cur - s.readBack) > 0.001)
      s.pos = cur;
    s.pos += (vt - s.at) * rate;
    s.at = vt;
    const end = Number(a.effect.getComputedTiming().endTime ?? Infinity);
    // At its end within Blink's own time tolerance (1 µs) is at its end:
    // finished on the frame Blink already draws it ended.
    const atEnd =
      rate < 0 ? s.pos <= 0.001 : Number.isFinite(end) && s.pos >= end - 0.001;
    if (atEnd) {
      // A paused animation never finishes on its own: finish it, so its
      // `finished` promise, finish event and transitionend still come.
      s.done = true;
      owned.delete(a);
      a.finish();
    } else {
      a.currentTime = s.pos;
      s.readBack = isNum(a.currentTime) ? a.currentTime : null;
    }
  };
  Animation.prototype.pause = function (this: Animation): void {
    const s = scrubOf(this);
    // Driven up to now, then left where the app paused it.
    if (isVirtual && owned.has(this) && !s.done && !s.appPaused)
      advance(this, s);
    s.appPaused = true;
    owned.delete(this);
    nativePause.call(this);
  };
  Animation.prototype.play = function (this: Animation): void {
    nativePlay.call(this);
    // Real time: it runs as on any page; start() adopts it like any other.
    if (!isVirtual) {
      scrubs.delete(this);
      return;
    }
    const s = scrubOf(this);
    s.appPaused = false;
    s.done = false;
    // Resumed (or replayed) by the app: driven on virtual time from the
    // playhead play() left it on (a pending play holds its time; a finished
    // one rewinds) — never run on the real timeline while the recorder
    // waits, which would play it out between two frames.
    s.pos = isNum(this.currentTime) ? this.currentTime : 0;
    s.at = vt;
    s.readBack = null;
    nativePause.call(this);
    owned.add(this);
  };
  // `startTime =` is a play too: it clears the animation's hold time and runs
  // it on its timeline from that instant. An app that dates its tween itself
  // (the fold primitive: `el.animate(…)`, then `anim.startTime =
  // performance.now()`, so a slow mount delays the motion instead of
  // swallowing it) hands it a VIRTUAL instant — and the native setter runs
  // it on the document timeline, whose time is real and far ahead: the
  // animation is past its end before the next frame is captured (Sonata's
  // Current key section snapped open and shut in the film; every fold did).
  // So in virtual mode the clock takes it as the app means it: driven on
  // virtual time with its playhead at (now − startTime) × rate, and read
  // back in virtual time. The document timeline's own time reads virtual
  // too, so a start time computed from it is on the same clock.
  const startTimeDesc = Object.getOwnPropertyDescriptor(
    Animation.prototype,
    "startTime",
  );
  const onDocTimeline = (a: Animation): boolean =>
    a.timeline === null || a.timeline === document.timeline;
  if (startTimeDesc?.get && startTimeDesc.set) {
    const nativeStartGet = startTimeDesc.get;
    const nativeStartSet = startTimeDesc.set;
    Object.defineProperty(Animation.prototype, "startTime", {
      configurable: true,
      enumerable: startTimeDesc.enumerable,
      get(this: Animation): CSSNumberish | null {
        const s = scrubs.get(this);
        if (!isVirtual || !owned.has(this) || !s || s.appPaused || s.done)
          return nativeStartGet.call(this) as CSSNumberish | null;
        return s.at - s.pos / (this.playbackRate || 1);
      },
      set(this: Animation, value: CSSNumberish | null): void {
        if (!isVirtual || !onDocTimeline(this) || !isNum(value)) {
          nativeStartSet.call(this, value);
          // Unset (a hold): the app's pause.
          if (isVirtual && value === null) {
            scrubOf(this).appPaused = true;
            owned.delete(this);
          }
          return;
        }
        const s = scrubOf(this);
        s.appPaused = false;
        s.done = false;
        s.pos = (vt - value) * this.playbackRate;
        s.at = vt;
        s.readBack = null;
        if (this.playState !== "paused") nativePause.call(this);
        owned.add(this);
        this.currentTime = s.pos;
        s.readBack = isNum(this.currentTime) ? this.currentTime : null;
      },
    });
  }
  const timelineTime = Object.getOwnPropertyDescriptor(
    AnimationTimeline.prototype,
    "currentTime",
  );
  if (timelineTime?.get) {
    const nativeTimelineGet = timelineTime.get;
    Object.defineProperty(AnimationTimeline.prototype, "currentTime", {
      configurable: true,
      enumerable: timelineTime.enumerable,
      get(this: AnimationTimeline): CSSNumberish | null {
        if (isVirtual && this === document.timeline) return vt;
        return nativeTimelineGet.call(this) as CSSNumberish | null;
      },
    });
  }
  const syncAnimations = (): void => {
    const seen = new Set(document.getAnimations());
    for (const a of owned) {
      // Cancelled (its element removed, its transition replaced) or finished
      // by the app itself: no longer the clock's.
      if (a.playState === "idle" || a.playState === "finished") owned.delete(a);
      else seen.add(a);
    }
    for (const a of seen) {
      // A scroll- or view-driven animation (`animation-timeline: scroll()` /
      // `view()`) runs on progress, not time: its playhead is the scroll
      // position, which the recording drives itself — setting it in ms
      // throws. Only document-timeline animations are the clock's.
      if (a.timeline !== null && a.timeline !== document.timeline) continue;
      if (!a.effect) continue;
      const s = scrubOf(a);
      if (a.playState === "running" && (s.appPaused || s.done)) {
        // Played again without play() (reverse(), a CSS play-state flip):
        // the app's again, from where it is now.
        s.appPaused = false;
        s.done = false;
        s.pos = isNum(a.currentTime) ? a.currentTime : 0;
        s.at = vt;
        s.readBack = null;
      }
      if (s.done || s.appPaused) continue;
      if (a.playState !== "paused") nativePause.call(a);
      owned.add(a);
      advance(a, s);
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
