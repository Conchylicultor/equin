import { clamp01, EASE, n1, type Ease, type EaseName } from "./math";
import { grect } from "./night";
import { rect, setAttr } from "./svg";

/**
 * A frame's own looping animation, as a pure function of the loop's time.
 *
 * Parts: a pane (x, y, w, h, o — its content clipped to it, riding its
 * top-left), an item (x, y, s, o), a fade (o — it rides inside a pane, so it
 * has no position of its own), a link (a path drawing itself: p, o).
 *
 * `at(t, part, to, duration, ease)` tweens a part toward `to` at second t of
 * the loop; a later step on a property takes over from wherever the earlier
 * one had got to. Because a state is a function of the time, a loop is free to
 * end exactly where it began.
 *
 * The parts are written as markup (`pane()`, `item()`, …, each returning its
 * string), then `bind(root)` finds them in the mounted drawing.
 */

type PartType = "pane" | "fade" | "item" | "link";
export type PaneState = {
  x: number;
  y: number;
  w: number;
  h: number;
  o: number;
};
type Values = Record<string, number>;

interface Track {
  t: number;
  to: number;
  dur: number;
  ease: Ease;
  from: number;
}

interface Part {
  type: PartType;
  init: Values;
  cur: Values;
  tracks: Record<string, Track[]>;
  el?: SVGGraphicsElement;
  rects?: SVGRectElement[];
  content?: SVGGElement;
  links?: SVGPathElement[];
}

interface Step {
  t: number;
  n: string;
  to: Values;
  dur: number;
  ease: Ease;
}

export class Timeline {
  readonly parts: Record<string, Part> = {};
  private readonly steps: Step[] = [];
  tau = 0;

  /** `prefix` makes the parts' ids unique in the document (clip paths are looked up by id). */
  constructor(
    private readonly prefix: string,
    readonly len: number,
  ) {}

  id(n: string): string {
    return `${this.prefix}-${n}`;
  }

  private reg(n: string, type: PartType, init: Values) {
    this.parts[n] = { type, init, cur: { ...init }, tracks: {} };
  }

  /** A window of the drawing: its content clipped to it, `solid` on an opaque ground. */
  pane(
    n: string,
    col: string,
    content: string,
    init: PaneState,
    solid = false,
  ): string {
    this.reg(n, "pane", init);
    const id = this.id(n);
    return (
      `<g id="${id}"><clipPath id="${id}-c"><rect rx="12"/></clipPath>` +
      (solid ? rect(0, 0, 0, 0, "zb-pop", 12) : "") +
      grect(0, 0, 0, 0, 12, col) +
      `<g clip-path="url(#${id}-c)"><g class="zs-c">${content}</g></g></g>`
    );
  }

  fade(n: string, content: string): string {
    this.reg(n, "fade", { o: 0 });
    return `<g id="${this.id(n)}" style="opacity:0">${content}</g>`;
  }

  item(
    n: string,
    content: string,
    init: { x: number; y: number; s: number; o: number },
  ): string {
    this.reg(n, "item", init);
    return `<g id="${this.id(n)}">${content}</g>`;
  }

  /** A path that draws itself. `cls` lands on both its glow and its line. */
  link(
    n: string,
    d: string,
    col: string,
    init: { p: number; o: number },
    cls = "",
  ): string {
    this.reg(n, "link", init);
    const c = cls ? ` ${cls}` : "";
    return (
      `<path id="${this.id(n)}" class="zs-glow${c}" pathLength="100" stroke="${col}" d="${d}"/>` +
      `<path id="${this.id(n)}-l" class="zs-link${c}" pathLength="100" stroke="${col}" d="${d}"/>`
    );
  }

  at(t: number, n: string, to: Values, dur?: number, ease?: EaseName): this {
    const part = this.parts[n];
    if (!part) throw new Error(`timeline ${this.prefix}: no part ${n}`);
    if (t >= this.len)
      throw new Error(
        `timeline ${this.prefix}: step at ${t}s is past the loop (${this.len}s)`,
      );
    for (const key in to)
      if (!(key in part.init))
        throw new Error(
          `timeline ${this.prefix}: part ${n} has no initial ${key}`,
        );
    this.steps.push({ t, n, to, dur: dur ?? 0.8, ease: EASE[ease ?? "io"] });
    return this;
  }

  /** Find every part in the mounted drawing, compile the steps into tracks, and draw the start. */
  bind(root: ParentNode): void {
    const find = <E extends Element>(id: string): E => {
      const el = root.querySelector<E>(`#${CSS.escape(id)}`);
      if (!el)
        throw new Error(
          `timeline ${this.prefix}: part ${id} is not in the page`,
        );
      return el;
    };
    for (const [n, p] of Object.entries(this.parts)) {
      const el = find<SVGGraphicsElement>(this.id(n));
      p.el = el;
      if (p.type === "pane") {
        p.rects = [
          ...el.querySelectorAll<SVGRectElement>(":scope > rect"),
          el.querySelector<SVGRectElement>("clipPath rect")!,
        ];
        p.content = el.querySelector<SVGGElement>(".zs-c")!;
      }
      if (p.type === "link")
        p.links = [
          el as unknown as SVGPathElement,
          find<SVGPathElement>(`${this.id(n)}-l`),
        ];
      p.tracks = {};
    }
    // one track per (part, property), in time order; each step starts from where the one before had got to
    this.steps
      .map((s, i) => [s, i] as const)
      .sort((a, b) => a[0].t - b[0].t || a[1] - b[1])
      .forEach(([s]) => {
        const p = this.parts[s.n]!;
        for (const key in s.to)
          (p.tracks[key] ??= []).push({
            t: s.t,
            to: s.to[key]!,
            dur: s.dur,
            ease: s.ease,
            from: 0,
          });
      });
    for (const p of Object.values(this.parts)) {
      for (const key in p.tracks) {
        const tr = p.tracks[key]!;
        let v = p.init[key]!;
        tr.forEach((st, i) => {
          if (i > 0) v = ev(tr[i - 1]!, st.t);
          st.from = v;
        });
      }
    }
    this.render();
  }

  render(): void {
    const tau = this.tau;
    for (const p of Object.values(this.parts)) {
      for (const key in p.init) {
        const tr = p.tracks[key];
        let v = p.init[key]!;
        if (tr)
          for (let i = tr.length - 1; i >= 0; i--)
            if (tr[i]!.t <= tau) {
              v = ev(tr[i]!, tau);
              break;
            }
        p.cur[key] = v;
      }
      apply(p);
    }
  }

  /** Always real time: a loop never speeds up. */
  advance(dt: number): void {
    this.tau = (this.tau + dt) % this.len;
  }

  /** A pane's current box and opacity. */
  paneState(n: string): PaneState {
    const c = this.parts[n]!.cur;
    return { x: c.x!, y: c.y!, w: c.w!, h: c.h!, o: c.o! };
  }

  /** A part's mounted node. */
  node(n: string): SVGGraphicsElement {
    return this.parts[n]!.el!;
  }
}

function ev(st: Track, tau: number): number {
  const f = st.dur <= 0 ? 1 : clamp01((tau - st.t) / st.dur);
  return st.from + (st.to - st.from) * st.ease(f);
}

function apply(p: Part): void {
  const c = p.cur;
  const o = clamp01(c.o!).toFixed(3);
  switch (p.type) {
    case "pane":
      for (const r of p.rects!) {
        setAttr(r, "x", String(n1(c.x!)));
        setAttr(r, "y", String(n1(c.y!)));
        setAttr(r, "width", String(n1(Math.max(0, c.w!))));
        setAttr(r, "height", String(n1(Math.max(0, c.h!))));
      }
      setAttr(p.content!, "transform", `translate(${n1(c.x!)} ${n1(c.y!)})`);
      break;
    case "fade":
      break;
    case "item":
      setAttr(
        p.el!,
        "transform",
        `translate(${n1(c.x!)} ${n1(c.y!)}) scale(${Math.max(0.001, c.s!).toFixed(3)})`,
      );
      break;
    case "link":
      for (const e of p.links!) {
        e.style.strokeDashoffset = (100 * (1 - clamp01(c.p!))).toFixed(2);
        e.style.opacity = o;
      }
      return;
  }
  p.el!.style.opacity = o;
}
