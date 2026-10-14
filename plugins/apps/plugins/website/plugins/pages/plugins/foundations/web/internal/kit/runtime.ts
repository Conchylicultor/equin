import {
  createInViewWatcher,
  type InViewWatcher,
} from "@plugins/primitives/plugins/dom/plugins/in-view/web";
import { DRAW, Kit, KIT_WIDTH } from "./draw";
import type { AnyCardDef, CardCtx, KitElement } from "./types";

/**
 * The card runtime: one per iceberg scene. It mounts a card into its piece's
 * `.vz` box when the piece opens and unmounts it when it closes, walks a card's
 * states (showing the pieces of the new state and fading in only the ones that
 * just appeared), runs every card's autoplay from ONE clock that ticks only the
 * cards open and on screen, and dispatches each card's controls.
 *
 * A mounted card's markup is rendered once and never rebuilt: a state change
 * flips attributes and classes in place (`data-in` → `k-off` / `k-enter`,
 * `data-on` → `k-sel`), which is what keeps hover, focus and running SMIL alive
 * across state changes.
 */
export interface CardRuntime {
  /** Mount the card of an iceberg piece (its `.vz[data-card]`), if it has one. */
  open(item: Element): void;
  /** Unmount the card of an iceberg piece. */
  close(item: Element): void;
  /** Mount a card into a `.vz[data-card]` box directly. */
  mount(vz: HTMLElement): void;
  unmount(vz: HTMLElement): void;
  /** Pause / resume every autoplay. */
  pause(on: boolean): void;
  /** Debug: timers, frames and listeners registered by mounted cards (0 once every card is closed). */
  live(): number;
  mounted(): number;
  dispose(): void;
}

/** A touch on a card holds its loop this long after the last touch, then it carries on from where the reader left it. */
const IDLE = 8000;
/** A link a shot lit stays lit this long (s) after its token arrived. */
const HOLD = 0.35;

interface Auto {
  vis: boolean;
  next: number;
  /** The position in `seq` (a seq may visit a state twice, so the state alone cannot say where it is). */
  i: number;
  first: boolean;
}

interface Inst {
  key: string;
  def: AnyCardDef;
  vz: HTMLElement;
  root: HTMLElement;
  state: number;
  subs: Set<() => void>;
  run: (() => void)[];
  /** The links a shot has lit, each with the disposer of its return to rest. */
  flashes: Map<KitElement, () => void>;
  auto: Auto | null;
  watcher: InViewWatcher | null;
  ctx: CardCtx<any>;
}

const has = (list: string | undefined, s: number | string) =>
  (list ?? "").split(" ").includes(String(s));

const isKitElement = (el: Element): el is KitElement =>
  el instanceof HTMLElement || el instanceof SVGElement;

/** One-shot SMIL in a piece that appears or lights (a token a link sends) starts now, after its own `data-d`. */
const begin = (el: Element) =>
  el
    .querySelectorAll<SVGAnimationElement>('[begin="indefinite"]')
    .forEach((a) => a.beginElementAt(Number(a.dataset.d ?? 0)));

export function createCardRuntime(
  host: HTMLElement,
  cards: Readonly<Record<string, AnyCardDef>>,
): CardRuntime {
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const insts = new Map<HTMLElement, Inst>();
  let live = 0;
  let paused = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  // ---------- states ----------
  function go(inst: Inst, s: number, first = false) {
    const { root } = inst;
    const entering: KitElement[] = [];
    const changed = inst.state !== s;
    inst.state = s;
    root.dataset.s = String(s);
    root.querySelectorAll<KitElement>("[data-in]").forEach((el) => {
      const was = !el.classList.contains("k-off");
      const now = has(el.dataset.in, s);
      el.classList.toggle("k-off", !now);
      if (!now) el.classList.remove("k-enter");
      // data-replay: a piece shown in several states that plays its entrance again on every change
      else if (!first && (!was || (changed && el.hasAttribute("data-replay"))))
        entering.push(el);
    });
    // a piece that lights replays its motion (a link draws itself again), so it is lit only after the flush below
    const lighting: KitElement[] = [];
    root.querySelectorAll<KitElement>("[data-on]").forEach((el) => {
      const now = has(el.dataset.on, s);
      if (now && !first && !el.classList.contains("k-sel")) lighting.push(el);
      else el.classList.toggle("k-sel", now);
    });
    if (!entering.length && !lighting.length) return;
    // restart cleanly even if the piece was hidden and shown again (or unlit and lit again) since the last frame
    entering.forEach((el) => el.classList.remove("k-enter"));
    void root.offsetWidth;
    entering.forEach((el) => {
      el.classList.add("k-enter");
      begin(el);
    });
    lighting.forEach((el) => {
      el.classList.add("k-sel");
      begin(el);
    });
  }

  // A card never changes size: its root is held at the height of its TALLEST
  // state, measured by visiting every state once before the first paint, so a
  // state that shows more pieces fills space the card already has instead of
  // pushing the page below it. Measured again once the web fonts land.
  function lockHeight(inst: Inst) {
    const n = inst.def.states;
    if (!n) return;
    const measure = () => {
      if (!insts.has(inst.vz)) return;
      const cur = inst.state;
      const { root } = inst;
      root.style.minHeight = "";
      let h = 0;
      for (let s = 0; s < n; s++) {
        go(inst, s, true);
        h = Math.max(h, root.offsetHeight);
      }
      go(inst, cur, true);
      if (h) root.style.minHeight = `${h}px`;
    };
    measure();
    if (document.fonts.status !== "loaded")
      void document.fonts.ready.then(measure);
  }

  // ---------- ctx ----------
  function makeCtx(inst: Inst): CardCtx<any> {
    // every registration returns its disposer; the instance holds them all until unmount
    const track = (cancel: () => void) => {
      let done = false;
      const dispose = () => {
        if (done) return;
        done = true;
        inst.subs.delete(dispose);
        live--;
        cancel();
      };
      inst.subs.add(dispose);
      live++;
      return dispose;
    };
    const ctx: CardCtx<Record<string, unknown>> = {
      key: inst.key,
      root: inst.root,
      data: {},
      get state() {
        return inst.state;
      },
      go: (s) => go(inst, s),
      after(ms, fn) {
        const id = setTimeout(() => {
          d();
          fn();
        }, ms);
        const d = track(() => clearTimeout(id));
        return d;
      },
      frame(fn) {
        const id = requestAnimationFrame((t) => {
          d();
          fn(t);
        });
        const d = track(() => cancelAnimationFrame(id));
        return d;
      },
      on(target, type, fn, opts) {
        const listener = fn as EventListener;
        target.addEventListener(type, listener, opts);
        return track(() => target.removeEventListener(type, listener, opts));
      },
      run(seq) {
        inst.run.forEach((d) => d());
        const end = Math.max(...seq.map(([t]) => t));
        inst.root.dataset.running = "";
        inst.run = seq
          .filter(([t]) => t > 0)
          .map(([t, s]) => ctx.after(t, () => go(inst, s)));
        seq.filter(([t]) => t <= 0).forEach(([, s]) => go(inst, s));
        inst.run.push(ctx.after(end, () => delete inst.root.dataset.running));
      },
      // its one-shot SMIL starts; a link fired by it (link's `shot`) lights and
      // sends its token, then goes back to rest once the token has arrived (a
      // newer shot restarts it)
      fire(shot) {
        inst.root
          .querySelectorAll<KitElement>(`[data-shot="${shot}"]`)
          .forEach((el) => {
            if (!el.classList.contains("k-link")) return begin(el);
            inst.flashes.get(el)?.();
            el.classList.remove("k-sel");
            void el.getBoundingClientRect();
            el.classList.add("k-sel");
            begin(el);
            const ms = (Number(el.dataset.d ?? 0) + DRAW + HOLD) * 1000;
            inst.flashes.set(
              el,
              ctx.after(ms, () => el.classList.remove("k-sel")),
            );
          });
      },
      highlight(id) {
        const near = new Set(id ? [id] : []);
        inst.root
          .querySelectorAll<KitElement>("[data-a][data-b]")
          .forEach((e) => {
            const on =
              !!id &&
              !e.classList.contains("k-off") &&
              (e.dataset.a === id || e.dataset.b === id);
            e.classList.toggle("k-hl", on);
            if (on) {
              near.add(e.dataset.a ?? "");
              near.add(e.dataset.b ?? "");
            }
          });
        // a node with no edges lights only itself
        inst.root.classList.toggle("k-hov", near.size > 1);
        inst.root.querySelectorAll<KitElement>("[data-node]").forEach((n) => {
          n.classList.toggle("k-near", near.has(n.dataset.node ?? ""));
          n.classList.toggle("k-self", n.dataset.node === id);
        });
      },
      hold: () => holdAuto(inst),
      part(el, s, still = false) {
        const entering: KitElement[] = [];
        if (!isKitElement(el))
          throw new Error(`[kit] part of "${inst.key}" is not an element`);
        el.dataset.p = s;
        el.querySelectorAll<KitElement>("[data-at]").forEach((p) => {
          const was = !p.classList.contains("k-off");
          const now = has(p.dataset.at, s);
          p.classList.toggle("k-off", !now);
          if (!now) p.classList.remove("k-enter");
          else if (!was && !still) entering.push(p);
        });
        entering.forEach((p) => p.classList.remove("k-enter"));
        void el.getBoundingClientRect();
        entering.forEach((p) => p.classList.add("k-enter"));
      },
      q<T extends Element>(sel: string): T {
        const el = inst.root.querySelector<T>(sel);
        if (!el) throw new Error(`[kit] card "${inst.key}" has no "${sel}"`);
        return el;
      },
      qa<T extends Element>(sel: string): T[] {
        return [...inst.root.querySelectorAll<T>(sel)];
      },
    };
    return ctx;
  }

  // ---------- mount / unmount ----------
  function mount(vz: HTMLElement) {
    if (insts.has(vz)) return;
    const key = vz.dataset.card ?? "";
    const def = cards[key];
    if (!def) throw new Error(`[kit] no card "${key}"`);
    const k = new Kit(KIT_WIDTH[def.width ?? "std"]);
    vz.innerHTML = `<span class="k-root" data-s="0">${def.render(k)}</span>`;
    const root = vz.firstElementChild;
    if (!(root instanceof HTMLElement))
      throw new Error(`[kit] card "${key}" rendered no root`);
    const item = vz.closest<HTMLElement>(".iceberg-item");
    if (item) item.dataset.cw = def.width ?? "std";
    const seq = def.autoplay?.seq ?? [];
    const inst: Inst = {
      key,
      def,
      vz,
      root,
      state: 0,
      subs: new Set(),
      run: [],
      flashes: new Map(),
      auto:
        def.autoplay && !reduced
          ? {
              vis: false,
              next: 0,
              i: Math.max(0, seq.indexOf(def.start ?? 0)),
              first: true,
            }
          : null,
      watcher: null,
      ctx: undefined as never,
    };
    inst.ctx = makeCtx(inst);
    insts.set(vz, inst);
    lockHeight(inst);
    go(inst, def.start ?? 0, true);
    def.mount?.(inst.ctx);
    if (inst.auto) {
      inst.watcher = createInViewWatcher((entries) =>
        onVisibility(inst, entries),
      );
      inst.watcher.observe(vz);
    }
  }

  function unmount(vz: HTMLElement) {
    const inst = insts.get(vz);
    if (!inst) return;
    insts.delete(vz);
    inst.watcher?.disconnect();
    [...inst.subs].forEach((dispose) => dispose());
    vz.textContent = "";
    schedule();
  }

  // ---------- actions: one delegated click + Enter/Space on [data-act] ----------
  function act(e: Event): boolean {
    const target = e.target;
    if (!(target instanceof Element)) return false;
    const el = target.closest("[data-act]");
    const vz = el?.closest<HTMLElement>(".vz");
    const inst = vz && insts.get(vz);
    if (!el || !inst || !inst.root.contains(el) || !isKitElement(el))
      return false;
    if (el.hasAttribute("data-busy") && inst.root.hasAttribute("data-running"))
      return true;
    const name = el.dataset.act ?? "";
    const fn = inst.def.actions?.[name];
    if (!fn)
      throw new Error(`[kit] card "${inst.key}" has no action "${name}"`);
    holdAuto(inst);
    fn(inst.ctx, el, e);
    return true;
  }
  const onClick = (e: MouseEvent) => void act(e);
  const onKey = (e: KeyboardEvent) => {
    if (
      (e.key === "Enter" || e.key === " ") &&
      e.target instanceof Element &&
      e.target.matches("[data-act]") &&
      act(e)
    )
      e.preventDefault();
  };
  host.addEventListener("click", onClick);
  host.addEventListener("keydown", onKey);

  // ---------- autoplay: one clock, ticking only cards that are open and on screen ----------
  function onVisibility(inst: Inst, entries: IntersectionObserverEntry[]) {
    const en = entries[entries.length - 1];
    const { auto } = inst;
    if (!en || !auto || !insts.has(inst.vz)) return;
    // coming into view: the state on screen gets its full time first
    if (en.isIntersecting && !auto.vis) {
      const lead = inst.def.autoplay?.lead;
      auto.next =
        performance.now() + (auto.first && lead != null ? lead : hold(inst));
      auto.first = false;
    }
    auto.vis = en.isIntersecting;
    schedule();
  }
  const ticking = (inst: Inst) => !!inst.auto?.vis;
  // how long the state on screen is held: `every`, or every[i] for the state at seq[i]
  const hold = (inst: Inst): number => {
    const every = inst.def.autoplay?.every ?? 0;
    return typeof every === "number" ? every : (every[inst.auto?.i ?? 0] ?? 0);
  };
  function schedule() {
    clearTimeout(timer);
    timer = undefined;
    if (paused) return;
    let next = Infinity;
    insts.forEach((inst) => {
      if (ticking(inst) && inst.auto) next = Math.min(next, inst.auto.next);
    });
    if (next < Infinity)
      timer = setTimeout(tick, Math.max(0, next - performance.now()));
  }
  function tick() {
    const now = performance.now();
    insts.forEach((inst) => {
      const { auto } = inst;
      const ap = inst.def.autoplay;
      if (!auto || !ap || !ticking(inst) || auto.next > now + 8) return;
      if (ap.step) ap.step(inst.ctx);
      else if (ap.seq) {
        auto.i = (auto.i + 1) % ap.seq.length;
        go(inst, ap.seq[auto.i] ?? 0);
      }
      auto.next = now + hold(inst);
    });
    schedule();
  }
  function holdAuto(inst: Inst) {
    if (!inst.auto) return;
    inst.auto.next = Math.max(inst.auto.next, performance.now() + IDLE);
    inst.auto.first = false;
    schedule();
  }

  const vzOf = (item: Element) =>
    item.querySelector<HTMLElement>(".vz[data-card]");

  return {
    open: (item) => {
      const vz = vzOf(item);
      if (vz) mount(vz);
    },
    close: (item) => {
      const vz = vzOf(item);
      if (vz) unmount(vz);
    },
    mount,
    unmount,
    pause(on) {
      paused = on;
      if (!on) {
        const now = performance.now();
        insts.forEach((i) => {
          if (i.auto) i.auto.next = now + hold(i);
        });
      }
      schedule();
    },
    live: () => live,
    mounted: () => insts.size,
    dispose() {
      [...insts.keys()].forEach(unmount);
      clearTimeout(timer);
      host.removeEventListener("click", onClick);
      host.removeEventListener("keydown", onKey);
    },
  };
}
