import { findScrollParent } from "@plugins/primitives/plugins/dom/plugins/auto-scroll/web";
import { revealElement } from "@plugins/primitives/plugins/dom/plugins/scroll-reveal/web";
import { clamp01 } from "./kit/math";
import { all, one } from "./kit/svg";
import type { Chapter } from "./ladder";
import { mountZoom } from "./zoom";

/**
 * The page's scroll skeleton: the hero, then the ladder pulled up under it — a
 * pinned stage (the zoom), the chapter cards scrolling over it, and the layer
 * strip pinned under the site header.
 *
 * Scroll → progress: p is where the screen's centre sits among the cards'
 * centres. While a card is read (its centre within HOLD of the middle), the
 * picture holds at its chapter; it moves on as the card leaves. p = 2.5 is
 * half-way from chapter 2 to 3.
 *
 * Everything is read from the PANE's scroll container, never the window: the
 * "screen" is its viewport (`--screen`), the header the part of it the site
 * header takes (`--vs-head`), and the hero dissolves over its first 60%
 * (`--h`). One measure per frame of scrolling; nothing runs while idle.
 */
export interface LadderScroll {
  /** The pane's viewport, or the page, changed size. */
  resize(): void;
  dispose(): void;
}

const HOLD = 0.15;

export function mountLadderScroll(
  root: HTMLElement,
  ladder: readonly Chapter[],
  prefix: string,
): LadderScroll {
  const scroller = findScrollParent(root);
  const vs = one<HTMLElement>(root, ".vs");
  const stage = one<HTMLElement>(root, ".vs-stage");
  const steps = all<HTMLElement>(root, ".vs-step");
  const cards = steps.map((s) => one<HTMLElement>(s, ".vs-card"));
  const strip = one<HTMLElement>(root, ".vs-strip");
  const segs = all<HTMLButtonElement>(strip, ".vs-strip-seg button");
  const num = one<HTMLElement>(strip, ".vs-strip-label b");
  const nm = one<HTMLElement>(strip, ".vs-strip-label span");

  const screen = () => scroller.clientHeight;
  const scrollerTop = () => scroller.getBoundingClientRect().top;

  // the stage is sized from the screen: fit the page's measures before the zoom lays itself out in it
  fit();
  const zoom = mountZoom(stage, {
    prefix,
    chapters: ladder.length,
    ideaRead: () =>
      cards[0]!.getBoundingClientRect().top - scrollerTop() < screen() * 0.82,
  });

  const onSeg = (e: MouseEvent) => {
    const i = segs.indexOf(e.currentTarget as HTMLButtonElement);
    revealElement(steps[i], { behavior: "smooth", block: "center" });
  };
  for (const b of segs) b.addEventListener("click", onSeg);

  // the page's measures, as the stylesheet reads them
  function fit() {
    root.style.setProperty("--screen", `${screen()}px`);
    const head =
      root.getBoundingClientRect().top - scrollerTop() + scroller.scrollTop;
    root.style.setProperty("--vs-head", `${Math.max(0, head)}px`);
  }

  let lastLayer = -1;
  let queued = 0;
  let disposed = false;
  function measure() {
    queued = 0;
    const top = scrollerTop();
    const s = screen();
    const mid = s / 2;
    const hold = s * HOLD;
    const centres = cards.map((c) => {
      const r = c.getBoundingClientRect();
      return r.top - top + r.height / 2;
    });
    const n = centres.length;
    let p = 0;
    if (mid <= centres[0]! + hold) p = 0;
    else if (mid >= centres[n - 1]! - hold) p = n - 1;
    else
      for (let i = 0; i < n - 1; i++) {
        const a = centres[i]! + hold;
        const b = centres[i + 1]! - hold;
        if (mid < a) {
          p = i;
          break;
        }
        if (mid < b) {
          p = i + (mid - a) / (b - a);
          break;
        }
      }
    const active = Math.round(p);
    steps.forEach((st, i) => st.classList.toggle("is-on", i === active));
    zoom.update(p);

    // the hero dissolves into the zoom over the first 60% of a screen
    const y = scroller.scrollTop;
    root.style.setProperty("--h", clamp01(y / (s * 0.6)).toFixed(3));
    // the layer strip: one segment per chapter, filling as the zoom passes it
    segs.forEach((b, i) =>
      b.style.setProperty("--fill", clamp01(p - i + 1).toFixed(3)),
    );
    if (active !== lastLayer) {
      lastLayer = active;
      num.textContent = `0${active}`;
      nm.textContent = ladder[active]!.name;
    }
    const r = vs.getBoundingClientRect();
    strip.classList.toggle(
      "is-live",
      y > s * 0.35 && r.top - top < s * 0.45 && r.bottom - top > s * 0.5,
    );
  }
  const queue = () => {
    if (!queued && !disposed) queued = requestAnimationFrame(measure);
  };
  scroller.addEventListener("scroll", queue, { passive: true });
  // the cards can still move after this first measure, with no scroll to tell: web fonts arriving
  void document.fonts.ready.then(queue);

  measure();
  return {
    resize() {
      fit();
      zoom.resize();
      queue();
    },
    dispose() {
      disposed = true;
      cancelAnimationFrame(queued);
      scroller.removeEventListener("scroll", queue);
      for (const b of segs) b.removeEventListener("click", onSeg);
      zoom.dispose();
    },
  };
}
