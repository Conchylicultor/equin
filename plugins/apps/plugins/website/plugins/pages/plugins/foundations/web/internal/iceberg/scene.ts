import {
  findScrollParent,
  keepInPlace,
  scrollChildIntoView,
} from "@plugins/primitives/plugins/dom/plugins/auto-scroll/web";
import type { CardRuntime } from "../kit/runtime";
import { drawBergIn } from "./berg";
import { depthReadout, maxHalf, rowWidths } from "./geometry";

/**
 * The iceberg page's behaviour, ported from the prototype's page script: the
 * berg drawn behind the layers from their measured offsets, the sky fitted to
 * exactly one screen, the depth gauge, the Components / Harness filter, Expand
 * all, and a piece opening in place — its neighbours and the berg gliding from
 * where they were to where they land (FLIP), the piece under the cursor held
 * still.
 *
 * React renders the scene's markup once (`IcebergSection`) and never again;
 * this owns it from then on, the way the prototype's script owns its DOM. The
 * page scrolls inside the pane, so every scroll read and write is the pane's
 * scroll container, never `window`.
 */
export interface IcebergScene {
  /** The pane's viewport changed size: refit when the screen changed, else redraw the berg. */
  onResize(): void;
  /** Open every piece, or close every one if all are open. */
  toggleAll(via: ExpandAllVia): void;
  dispose(): void;
}

const GLIDE_MS = 420;
const EASE = "cubic-bezier(.33,1,.68,1)";

type Rect = DOMRect;

const q = <T extends Element>(root: ParentNode, sel: string): T => {
  const el = root.querySelector<T>(sel);
  if (!el) throw new Error(`iceberg: no "${sel}"`);
  return el;
};

/** What a visitor used to Expand all: the pill, or its `E` shortcut. */
export type ExpandAllVia = "button" | "shortcut";

/** A piece, as its markup names it (`data-name`, `data-layer`). */
export interface OpenedPiece {
  name: string;
  layer: string;
}

/** What lies under the pane's pinned header. */
export type HeaderOver = "sky" | "sea";

export function mountIcebergScene({
  root,
  runtime,
  locs,
  idPrefix,
  onHeaderOver,
  onPieceOpen,
  onExpandAll,
}: {
  /** The section's root: the scene, the gauge and the Expand all pill. */
  root: HTMLElement;
  runtime: CardRuntime;
  /** Lines of code per layer, for the gauge. */
  locs: readonly number[];
  idPrefix: string;
  /**
   * What lies under the middle of the pane's pinned header: the sky until the
   * waterline passes it, then the sea. Told on mount and whenever it changes.
   */
  onHeaderOver: (over: HeaderOver) => void;
  /** The visitor opened one piece by clicking it (never told for Expand all). */
  onPieceOpen: (piece: OpenedPiece) => void;
  /** The visitor expanded every piece (never told for collapsing them). */
  onExpandAll: (via: ExpandAllVia) => void;
}): IcebergScene {
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const scene = q<HTMLElement>(root, ".iceberg-scene");
  const berg = q<HTMLElement>(root, ".iceberg-berg");
  const hero = q<HTMLElement>(root, ".iceberg-hero");
  const gauge = q<HTMLElement>(root, ".iceberg-gauge");
  const readout = q<HTMLElement>(root, ".iceberg-readout");
  const expander = q<HTMLElement>(root, ".iceberg-expander");
  const scroller = findScrollParent(scene);
  const layers = [...scene.querySelectorAll<HTMLElement>(".iceberg-layer")];
  const [L0, L1, L2] = firstThree(layers);
  let headerOver: HeaderOver | undefined;

  const pieces = () => [
    ...scene.querySelectorAll<HTMLElement>(".iceberg-item:not(.ghost)"),
  ];
  const allOpen = () => pieces().every((el) => el.classList.contains("open"));
  /** The pane's viewport: the one "screen" the sky is sized to. */
  const screenHeight = () => scroller.clientHeight;
  /** A layer's top in the scroller's content, comparable with `scrollTop`. */
  const contentTop = (el: HTMLElement) =>
    el.getBoundingClientRect().top -
    scroller.getBoundingClientRect().top +
    scroller.scrollTop;

  // ---------- layout ----------
  function sizeItems() {
    const W = scene.clientWidth;
    layers.forEach((sec, i) => {
      const { row, open } = rowWidths(W, i, layers.length);
      const rowEl = q<HTMLElement>(sec, ".iceberg-pieces");
      rowEl.style.setProperty("--row", row + "px");
      rowEl.style.setProperty("--row-open", open + "px");
      // on a phone the heading's text stays on the ice, where its colours were chosen for
      q<HTMLElement>(sec, ".iceberg-layer-head").style.maxWidth =
        W < 640 && i > 0 ? Math.max(row, 240) + "px" : "";
    });
  }

  // The tip rises to the top of the apps layer, just above "The apps", but never into "Descend ↓" above it:
  // on a short screen it stops 24px under that line.
  function tipOffset() {
    const dive = q<HTMLElement>(hero, ".iceberg-dive").getBoundingClientRect();
    const sc = scene.getBoundingClientRect();
    return Math.max(0, dive.bottom - sc.top + 24 - L0.offsetTop);
  }

  function drawDive() {
    drawBergIn(scene, berg, layers, {
      M: maxHalf(scene.clientWidth),
      tipOffset: tipOffset(),
      idPrefix,
    });
  }

  // The first screen is all sky: the waterline lands exactly at its bottom edge, so any scroll brings up the water.
  function fitSurface() {
    hero.style.paddingTop = hero.style.paddingBottom = "";
    // the sky is sized for the apps as pills: fold any open ones while measuring
    const opened = [...L0.querySelectorAll(".iceberg-item.open")];
    opened.forEach((el) => el.classList.remove("open"));
    const H = screenHeight();
    scene.style.setProperty("--svh", H / 100 + "px");
    // shrink until the sky fits the screen (never below .55)
    let fit = 1;
    scene.style.setProperty("--fit", "1");
    while (L1.offsetTop > H && fit > 0.56) {
      fit -= 0.05;
      scene.style.setProperty("--fit", fit.toFixed(2));
    }
    // room to spare: split it above and below the title, so the tip keeps its shape
    const spare = H - L1.offsetTop;
    if (spare > 0) {
      const cs = getComputedStyle(hero);
      hero.style.paddingTop = parseFloat(cs.paddingTop) + spare * 0.4 + "px";
      hero.style.paddingBottom =
        parseFloat(cs.paddingBottom) + spare * 0.6 + "px";
    }
    opened.forEach((el) => el.classList.add("open"));
  }

  // The readout: depth as real code — the lines in the layers you have passed below the apps.
  function onScroll() {
    // the header turns dark once its middle is below the waterline (the scene's top padding is the header's room)
    const over: HeaderOver =
      L1.getBoundingClientRect().top - scroller.getBoundingClientRect().top <
      parseFloat(getComputedStyle(scene).paddingTop) / 2
        ? "sea"
        : "sky";
    if (over !== headerOver) onHeaderOver((headerOver = over));
    const y = scroller.scrollTop;
    const vh = scroller.clientHeight;
    const mid = y + vh * 0.45;
    const tops = layers.map(contentTop);
    let cur = 0;
    tops.forEach((top, i) => {
      if (top <= mid) cur = i;
    });
    const curTop = tops[cur] ?? 0;
    const curEl = layers[cur] ?? L0;
    const t = Math.min(1, Math.max(0, (mid - curTop) / curEl.offsetHeight));
    const { value, label } = depthReadout(locs, {
      above: (tops[1] ?? 0) > mid,
      cur,
      t,
      atBottom: y + vh >= scroller.scrollHeight - 4,
    });
    readout.innerHTML = `<b>${value}</b><small>${label}</small>`;
    gauge
      .querySelectorAll<HTMLElement>("a")
      .forEach((a) => a.classList.toggle("on", Number(a.dataset.i) === cur));
    // a line above the waterline sits on the sky; one in the first water layer sits in the mid-blue shallows
    const water = L1.getBoundingClientRect().top;
    const shallowEnd = L2.getBoundingClientRect().top;
    let shallow = false;
    for (const el of gauge.children) {
      const r = el.getBoundingClientRect();
      const cy = r.top + r.height / 2;
      el.classList.toggle("dry", cy < water);
      if (cy >= water && cy < shallowEnd) shallow = true;
    }
    gauge.classList.toggle("plain", shallow);
  }

  function relayout() {
    sizeItems();
    fitSurface();
    drawDive();
    onScroll();
  }
  function redrawBerg() {
    drawDive();
    onScroll();
  }

  // ---------- a piece opens in place ----------
  function syncExpander() {
    const on = allOpen();
    expander.setAttribute("aria-pressed", String(on));
    q<HTMLElement>(expander, "span").textContent = on
      ? "Collapse all"
      : "Expand all";
  }

  const bandRects = () =>
    new Map(
      [...berg.querySelectorAll<SVGElement>(".iceberg-band")].map((b) => [
        b.dataset.b ?? "",
        b.getBoundingClientRect(),
      ]),
    );
  // An open or closing card's box (::after) travels between two rects by its edges (inset), not by a scale,
  // so its 1px border and its corners stay true the whole way; only the box repaints, never its neighbours.
  const edges = (r: Rect, b: Rect) =>
    `${r.top - b.top - 1}px ${b.right - r.right - 1}px ${b.bottom - r.bottom - 1}px ${r.left - b.left - 1}px`;
  // a name's scale is its type size's ratio, not its height's: a name that wraps in the card is taller, not bigger
  const nameBox = (el: HTMLElement) => {
    const nm = q<HTMLElement>(el, ".iceberg-name");
    return {
      rect: nm.getBoundingClientRect(),
      fs: parseFloat(getComputedStyle(nm).fontSize),
    };
  };
  let glideUntil = 0;

  /**
   * Keep the piece the reader is looking at still while everything around it
   * reflows, and glide every other piece from where it was to where it lands
   * (FLIP), so a reflow reads as motion, never as a jump.
   */
  function holdStill(
    anchor: HTMLElement | undefined,
    change: () => void,
    opened: readonly HTMLElement[] = [],
    closed: readonly HTMLElement[] = [],
  ) {
    // everything that can move on screen: the pieces, and the headings and text between them
    const els = [
      ...pieces(),
      ...scene.querySelectorAll<HTMLElement>(
        ".iceberg-layer-head, .iceberg-hero, .iceberg-foot",
      ),
    ];
    const first = new Map(els.map((el) => [el, el.getBoundingClientRect()]));
    const firstBands = bandRects();
    const firstNames = new Map(
      [...opened, ...closed].map((el) => [el, nameBox(el)]),
    );
    // a closing card's text, copied before it folds, to fade out where it was read
    const vh0 = window.innerHeight;
    const ghosts = new Map(
      reduced
        ? []
        : closed
            .filter((el) => {
              const r = first.get(el);
              return !!r && r.bottom > -200 && r.top < vh0 + 200;
            })
            .map((el) => {
              const g = document.createElement("div");
              g.className =
                el.className.replace(/\b(active|closing)\b/g, "") + " ghost";
              g.setAttribute("style", el.getAttribute("style") ?? "");
              g.setAttribute("aria-hidden", "true");
              g.innerHTML = el.innerHTML;
              return [el, g] as const;
            }),
    );
    // pin the anchor's top edge, so the piece under the cursor stays on its line and unfolds downward;
    // only the berg follows the content: the sky's fit belongs to the screen, not to what is open
    keepInPlace(scroller, anchor ?? null, () => {
      change();
      redrawBerg();
    });
    onScroll();
    if (reduced) return;
    glideUntil = performance.now() + GLIDE_MS + 50;
    const vh = window.innerHeight;
    const offscreen = (a: Rect, b: Rect) =>
      (a.bottom < -200 && b.bottom < -200) ||
      (a.top > vh + 200 && b.top > vh + 200);
    const glide = { duration: GLIDE_MS, easing: EASE };
    // berg strips: move and stretch from where each was seen
    berg.querySelectorAll<SVGElement>(".iceberg-band").forEach((band) => {
      const a = firstBands.get(band.dataset.b ?? "");
      const b = band.getBoundingClientRect();
      if (
        !a ||
        offscreen(a, b) ||
        (Math.abs(a.top - b.top) < 0.5 && Math.abs(a.height - b.height) < 0.5)
      )
        return;
      band.animate(
        [
          {
            transform: `translateY(${a.top - b.top}px) scaleY(${a.height / b.height})`,
          },
          { transform: "none" },
        ],
        glide,
      );
    });
    const slideName = (el: HTMLElement) => {
      const nm = q<HTMLElement>(el, ".iceberg-name");
      const na = firstNames.get(el);
      const nb = nameBox(el);
      if (!na) return;
      // (and eases from the pill's type size to the card's, instead of popping)
      nm.style.transformOrigin = "0 0";
      nm.animate(
        [
          {
            transform: `translate(${na.rect.left - nb.rect.left}px, ${na.rect.top - nb.rect.top}px) scale(${na.fs / nb.fs})`,
          },
          { transform: "none" },
        ],
        glide,
      );
    };
    els.forEach((el) => {
      const a = first.get(el);
      const b = el.getBoundingClientRect();
      if (!a || offscreen(a, b)) return;
      if (closed.includes(el)) {
        // a closing card is an opening one played backwards: its box shrinks from the card into the pill,
        // the name slides back into the pill, and the description fades out where it was
        el.classList.add("closing");
        const box = el.animate(
          [
            { inset: edges(a, b), borderRadius: "16px" },
            { inset: "-1px", borderRadius: `${b.height / 2 + 1}px` },
          ],
          { ...glide, pseudoElement: "::after" },
        );
        const settle = () => {
          if (!el.classList.contains("open")) el.classList.remove("closing");
        };
        box.onfinish = settle;
        box.oncancel = settle;
        slideName(el);
        const g = ghosts.get(el);
        if (g) {
          Object.assign(g.style, {
            left: a.left - b.left + "px",
            top: a.top - b.top + "px",
            width: a.width + "px",
          });
          el.appendChild(g);
          g.animate([{ opacity: 1 }, { opacity: 0 }], {
            duration: 140,
            easing: "ease-out",
            fill: "forwards",
          }).onfinish = () => g.remove();
        }
        return;
      }
      if (opened.includes(el)) {
        // an opening card grows out of the pill it was: its box (::after) from the pill's box to its own,
        // the name slides from its place in the pill to its place in the card, the description fades in
        el.animate(
          [
            { inset: edges(a, b), borderRadius: `${a.height / 2 + 1}px` },
            { inset: "-1px", borderRadius: "16px" },
          ],
          { ...glide, pseudoElement: "::after" },
        );
        slideName(el);
        // the description and diagram ride with the box's corner while they fade in, never ahead of it
        el.querySelectorAll<HTMLElement>(".iceberg-desc, .vz").forEach((d) =>
          d.animate(
            [
              {
                transform: `translate(${a.left - b.left}px, ${a.top - b.top}px)`,
              },
              { transform: "none" },
            ],
            glide,
          ),
        );
        return;
      }
      const dx = a.left + a.width / 2 - (b.left + b.width / 2);
      const dy = a.top + a.height / 2 - (b.top + b.height / 2);
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return;
      el.animate(
        [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "none" }],
        glide,
      );
    });
  }

  function toggleInline(el: HTMLElement) {
    const opening = !el.classList.contains("open");
    holdStill(
      el,
      () => {
        el.classList.toggle("open");
        el.setAttribute("aria-expanded", String(opening));
        if (opening) runtime.open(el);
        else runtime.close(el);
      },
      opening ? [el] : [],
      opening ? [] : [el],
    );
    syncExpander();
    if (opening) onPieceOpen(openedPiece(el));
  }

  // Expand all unfolds every piece, turning the iceberg into the full reference without leaving it.
  function toggleAll(via: ExpandAllVia) {
    const on = !allOpen();
    expandAll(on);
    if (on) onExpandAll(via);
  }

  function expandAll(on: boolean) {
    // anchor on the first piece at or below 40% of the screen
    const mid =
      scroller.getBoundingClientRect().top + scroller.clientHeight * 0.4;
    const anchor = pieces().find(
      (el) => el.getBoundingClientRect().bottom > mid,
    );
    const opening = on
      ? pieces().filter((el) => !el.classList.contains("open"))
      : [];
    const closing = on
      ? []
      : pieces().filter((el) => el.classList.contains("open"));
    holdStill(
      anchor,
      () => {
        pieces().forEach((el) => {
          el.classList.toggle("open", on);
          el.setAttribute("aria-expanded", String(on));
        });
        opening.forEach((el) => runtime.open(el));
        closing.forEach((el) => runtime.close(el));
      },
      opening,
      closing,
    );
    syncExpander();
  }

  // ---------- events ----------
  const onClick = (e: MouseEvent) => {
    const target = e.target;
    if (!(target instanceof Element)) return;
    if (target.closest(".iceberg-expander")) {
      toggleAll("button");
      return;
    }
    const f = target.closest<HTMLElement>(".iceberg-split-key button");
    if (f) {
      const on = scene.dataset.focus !== f.dataset.f;
      if (on) scene.dataset.focus = f.dataset.f;
      else delete scene.dataset.focus;
      root
        .querySelectorAll(".iceberg-split-key button")
        .forEach((b) => b.setAttribute("aria-pressed", String(on && b === f)));
      return;
    }
    // a click inside an open card's drawing never folds it (its controls are run by the kit)
    if (target.closest(".iceberg-item.open .vz")) return;
    const t = target.closest<HTMLElement>("button.iceberg-item");
    if (t) toggleInline(t);
  };
  // a gauge tick jumps to its layer inside the pane's scroll (never the document's)
  const onGauge = (e: MouseEvent) => {
    const a =
      e.target instanceof Element
        ? e.target.closest<HTMLElement>("a[data-i]")
        : null;
    const layer = a ? layers[Number(a.dataset.i)] : undefined;
    if (!layer) return;
    e.preventDefault();
    scrollChildIntoView(scroller, layer, { block: "start" });
  };
  root.addEventListener("click", onClick);
  gauge.addEventListener("click", onGauge);
  scroller.addEventListener("scroll", onScroll, { passive: true });

  // Refit only when the screen itself changes size. A page that grows (a card unfolding) only needs the berg
  // redrawn, and a glide in flight already drew it for the new page height.
  let screenKey = "";
  const onResize = () => {
    const key = scene.clientWidth + "x" + screenHeight();
    if (key === screenKey) {
      if (performance.now() >= glideUntil) redrawBerg();
      return;
    }
    screenKey = key;
    relayout();
  };
  let disposed = false;
  void document.fonts.ready.then(() => {
    if (!disposed) relayout();
  });
  onResize();

  return {
    onResize,
    toggleAll,
    dispose() {
      disposed = true;
      root.removeEventListener("click", onClick);
      gauge.removeEventListener("click", onGauge);
      scroller.removeEventListener("scroll", onScroll);
    },
  };
}

function openedPiece(el: HTMLElement): OpenedPiece {
  const { name, layer } = el.dataset;
  if (name === undefined || layer === undefined)
    throw new Error("iceberg: a piece without data-name / data-layer");
  return { name, layer };
}

/** The apps, the first water layer and the one under it — the scene needs all three. */
function firstThree(
  layers: HTMLElement[],
): [HTMLElement, HTMLElement, HTMLElement] {
  const [a, b, c] = layers;
  if (!a || !b || !c) throw new Error("iceberg: needs at least three layers");
  return [a, b, c];
}
