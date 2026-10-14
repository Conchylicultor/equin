import { defineCard, type CardCtx } from "../kit/types";
import "./window.css";

/**
 * Windowed loading: a ten-million-row page in a small viewport; only the rows
 * in view (and ~40 around them, the band on the scrollbar) are loaded. Scroll
 * it with the wheel over it, drag or click its scrollbar, or use the arrow
 * keys. The viewport holds a fixed pool of row elements: a scroll only moves
 * the pool and rewrites the rows' text when the top row changes, so rows always
 * show their content at once and nothing is rebuilt. The wheel is taken only
 * over the viewport and the scrollbar; anywhere else the page scrolls as usual.
 * Autoplay: a gentle scroll, then a long jump.
 */
const TOTAL = 10_000_000;
const VIS = 7;
/** A row's height — the same 22px `.wn-rw` sets in window.css. */
const RH = 22;
const LOADED = 40;
const START = 1_200_000;
const GLIDE = 650;
const NAMES = [
  "Invoice",
  "Order",
  "Ticket",
  "Shipment",
  "Payment",
  "Refund",
  "Signup",
  "Review",
];
const JUMPS = [6_400_000, 2_100_000, 8_700_000, 1_200_000];
const MAX = TOTAL - VIS;
const clamp = (p: number) => Math.min(MAX, Math.max(0, p));
const label = (n: number) => `#${(n + 1).toLocaleString("en-US")}`;
const barW = (n: number) => `${30 + ((n * 37) % 45)}%`;

export interface WindowData {
  pos: number;
  first: number;
  auto: number;
  raf: (() => void) | null;
  wn: HTMLElement;
  rows: HTMLElement;
  cells: HTMLElement[][];
}
type Ctx = CardCtx<WindowData>;

const draw = (D: WindowData) => {
  const first = Math.floor(D.pos);
  if (first !== D.first) {
    D.first = first;
    D.cells.forEach(([n, nm, bar], i) => {
      const r = first + i;
      if (!n || !nm || !bar) return;
      n.textContent = label(r);
      nm.textContent = NAMES[r % NAMES.length] ?? "";
      bar.style.width = barW(r);
    });
  }
  D.rows.style.transform = `translateY(${-(D.pos - first) * RH}px)`;
  D.wn.style.setProperty("--x", String(D.pos / MAX));
};

/** Move to `pos`: at once, or gliding there over GLIDE ms (one frame at a time, through ctx). */
const set = (ctx: Ctx, target: number, glide = false) => {
  const D = ctx.data;
  const pos = clamp(target);
  if (D.raf) {
    D.raf();
    D.raf = null;
  }
  if (!glide) {
    D.pos = pos;
    draw(D);
    return;
  }
  const from = D.pos;
  let t0 = 0;
  const step = (now: number) => {
    t0 = t0 || now;
    const u = Math.min(1, (now - t0) / GLIDE);
    const e = 1 - (1 - u) ** 3;
    D.pos = from + (pos - from) * e;
    draw(D);
    D.raf = u < 1 ? ctx.frame(step) : null;
  };
  D.raf = ctx.frame(step);
};

export const windowCard = defineCard<WindowData>({
  autoplay: {
    every: 2600,
    // alternate: a gentle scroll of a few rows, then a long jump
    step: (ctx) => {
      const D = ctx.data;
      const i = ++D.auto;
      set(ctx, i % 2 ? D.pos + 4 : (JUMPS[(i / 2) % JUMPS.length] ?? 0), true);
    },
  },
  // the pool: VIS + 1 rows (one more for the row sliding in), filled for the starting position
  render: () => {
    const rows = Array.from({ length: VIS + 1 }, (_, i) => {
      const r = START + i;
      return `<span class="wn-rw"><span class="wn-n">${label(r)}</span><span>${NAMES[r % NAMES.length]}</span><span class="k-bar" style="width:${barW(r)}"></span></span>`;
    }).join("");
    return (
      `<span class="k-html wn" style="--x:${START / MAX}">` +
      `<span class="k-panel wn-vp" tabindex="0" aria-label="A page of ten million rows: scroll it"><span class="wn-rows">${rows}</span><span class="wn-cnt">${LOADED} loaded</span></span>` +
      `<span class="wn-side"><span class="wn-lab"><b>10,000,000</b><br>rows</span>` +
      `<span class="wn-trk" tabindex="0" aria-label="Scrollbar"><span class="wn-band"></span><span class="wn-thumb"></span></span></span></span>`
    );
  },
  mount: (ctx) => {
    const D = ctx.data;
    const rows = ctx.q(".wn-rows");
    Object.assign(D, {
      pos: START,
      first: START,
      auto: 0,
      raf: null,
      wn: ctx.q(".wn"),
      rows,
    });
    D.cells = [...rows.children].map((rw) => [...rw.children] as HTMLElement[]);
    const vp = ctx.q(".wn-vp");
    const trk = ctx.q(".wn-trk");
    const trackPos = (y: number) => {
      const b = trk.getBoundingClientRect();
      return ((y - b.top - 8) / (b.height - 16)) * MAX;
    };
    // the wheel scrolls the mini page, never the real one — but only while the pointer is over the mini page
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      ctx.hold();
      set(ctx, D.pos + (e.deltaY || e.deltaX) / RH);
    };
    ctx.on(vp, "wheel", wheel, { passive: false });
    ctx.on(trk, "wheel", wheel, { passive: false });
    // the scrollbar: drag the thumb anywhere, or click the track to glide there
    ctx.on(trk, "pointerdown", (e) => {
      ctx.hold();
      trk.setPointerCapture(e.pointerId);
      const y0 = e.clientY;
      let dragged = false;
      const end = () => {
        mv();
        up();
        cancel();
      };
      const mv = ctx.on(trk, "pointermove", (ev) => {
        if (Math.abs(ev.clientY - y0) > 2) dragged = true;
        if (dragged) set(ctx, trackPos(ev.clientY));
      });
      const up = ctx.on(trk, "pointerup", (ev) => {
        end();
        if (!dragged) set(ctx, trackPos(ev.clientY), true);
      });
      const cancel = ctx.on(trk, "pointercancel", end);
    });
    // the keyboard: arrows a row, page keys a screen, Home / End the ends
    const KEYS: Record<string, number> = {
      ArrowDown: 1,
      ArrowUp: -1,
      PageDown: VIS,
      PageUp: -VIS,
    };
    const key = (e: KeyboardEvent) => {
      const by = KEYS[e.key];
      if (e.key === "Home" || e.key === "End")
        set(ctx, e.key === "Home" ? 0 : MAX, true);
      else if (by) set(ctx, Math.round(D.pos) + by, true);
      else return;
      e.preventDefault();
      ctx.hold();
    };
    ctx.on(vp, "keydown", key);
    ctx.on(trk, "keydown", key);
  },
});
