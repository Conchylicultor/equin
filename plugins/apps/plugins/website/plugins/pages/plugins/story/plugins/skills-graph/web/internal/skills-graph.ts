import { createInViewWatcher } from "@plugins/primitives/plugins/dom/plugins/in-view/web";
import { STORY_PALETTE_DECLS } from "@plugins/apps/plugins/website/plugins/pages/plugins/story/core";

/**
 * The skills graph: a simplified map of the author's skills, read as a program.
 * AGENTS.md is main(); an arrow is a real cross-reference (the source file names the target);
 * the meta skills — skills that improve the skills — wear --hl. Everyday entry points funnel into
 * the meta-fix, and the meta-fix into the update skill.
 * Layout: a balanced layered DAG — equal row gaps, parents centred over their children. Edges are cubic
 * splines that leave each label straight down and arrive straight down into the next, ending in a
 * small filled head.
 *
 * Ported verbatim from the prototype's `skills-graph.js` (`proto-1794207359-w7ez6h`): it draws into a
 * shadow root on its host and owns that DOM from mount on.
 */

// id: label (a "|" is where it may wrap when narrow), meta?, shown path, short description
type NodeSpec = readonly [
  label: string,
  meta: 0 | 1,
  file: string,
  words: string,
];
const NODES: Record<string, NodeSpec> = {
  main: ["AGENTS.md", 0, "AGENTS.md", "The entry point: it lists every skill."],
  task: [
    "complete a|task",
    0,
    "skills/workflow/complete-task.md",
    "Steps to finish a task end to end.",
  ],
  help: [
    "answer a|question",
    0,
    "skills/workflow/answer-question.md",
    "Answer, then fix what made the question necessary.",
  ],
  bug: [
    "fix a bug",
    0,
    "skills/engineering/fix-bug.md",
    "Reproduce first, theorize later.",
  ],
  tests: [
    "write tests|first",
    0,
    "skills/engineering/write-tests-first.md",
    "Write a failing test, then make it pass.",
  ],
  selfimp: [
    "self-|improvement",
    1,
    "skills/meta/self-improvement.md",
    "After each task, reflect on what to improve.",
  ],
  metafix: [
    "meta-fix",
    1,
    "skills/meta/meta-fix.md",
    "Fix the problem and what allowed it.",
  ],
  higher: [
    "think a level|higher",
    1,
    "skills/meta/think-higher.md",
    "Apply each lesson at every level, not just the first.",
  ],
  update: [
    "update skill",
    1,
    "skills/meta/update-skill.md",
    "Decide where a new lesson belongs in the skills.",
  ],
  write: [
    "write a skill",
    1,
    "skills/meta/write-skill.md",
    "How to write a good skill.",
  ],
};
// a balanced layered DAG: rows top to bottom (every arrow points down, and the order within a row
// keeps arrows from crossing). A row entry is [id, x as a fraction of the width] for the labels
// that set the shape — answer → meta-fix → think higher straight down one column, fix a bug →
// write tests first straight down another — or [id, ids] for a parent centred over its children
// (or a child under its parents), so the branches fan out evenly.
type RowEntry = readonly [id: string, at: number | readonly string[]];
const ROWS: readonly (readonly RowEntry[])[] = [
  [["main", ["help", "task"]]],
  [
    ["help", 0.2],
    ["task", ["bug", "selfimp"]],
  ],
  [
    ["bug", 0.44],
    ["selfimp", 0.95],
  ],
  [
    ["metafix", 0.2],
    ["tests", 0.44],
  ],
  [
    ["higher", 0.2],
    ["update", ["metafix", "selfimp"]],
  ],
  [["write", ["update"]]],
];
// the centred labels, in the order they can be placed (each after the labels it centres on)
const CENTRED = ["update", "write", "task", "main"];
// every edge is a real cross-reference between the skills (a simplified subset of them)
const EDGES: readonly (readonly [string, string])[] = [
  ["main", "help"],
  ["main", "task"],
  ["task", "bug"],
  ["task", "selfimp"],
  ["help", "metafix"],
  ["bug", "metafix"],
  ["bug", "tests"],
  ["metafix", "higher"],
  ["metafix", "update"],
  ["selfimp", "update"],
  ["update", "write"],
];
// one run of execution: main() → a task → a bug → its meta-fix → the skills get updated
const RUN = ["main", "task", "bug", "metafix", "update", "write"];
const NS = "http://www.w3.org/2000/svg";
const PAD = 2;

const CSS = `
  :host { ${STORY_PALETTE_DECLS}; display: block; position: relative; width: 100%; max-width: 640px; margin: 0 auto; }
  svg { display: block; width: 100%; overflow: visible; font-family: inherit; }
  .n text { fill: var(--fg2); text-anchor: middle; dominant-baseline: central; transition: opacity .25s; }
  .n.meta text { fill: var(--hl); font-weight: 600; }
  .n.root text { fill: var(--fg); font-family: var(--mono, ui-monospace, Menlo, monospace); font-weight: 600; }
  .n rect { fill: transparent; }
  .n { cursor: default; }
  .e .l { fill: none; stroke: var(--fg3); stroke-width: 1; opacity: .55; transition: opacity .2s, stroke-width .2s; }
  .e .a { fill: var(--fg3); opacity: .8; transition: opacity .2s; }
  .e.meta .l { stroke: var(--hl); opacity: .7; } .e.meta .a { fill: var(--hl); }
  svg.hov .e, svg.hov .n { opacity: .16; transition: opacity .2s; }
  svg.hov .e.on, svg.hov .n.on { opacity: 1; }
  svg.hov .e.on .l { opacity: 1; stroke-width: 1.5; } svg.hov .e.on .a { opacity: 1; }
  .dot { fill: var(--hl); }
  .tip { position: absolute; z-index: 2; pointer-events: none; max-width: 260px; padding: 8px 10px; border-radius: 8px;
    background: var(--panel); border: 1px solid var(--line); box-shadow: 0 4px 16px rgba(0,0,0,.12);
    font-size: 12.5px; line-height: 1.4; color: var(--fg2); opacity: 0; transition: opacity .15s; }
  .tip.on { opacity: 1; }
  .tip code { display: block; margin-bottom: 3px; font-family: var(--mono, ui-monospace, Menlo, monospace); font-size: 11.5px; color: var(--fg3); }`;

interface Placed {
  g: SVGGElement;
  hit: SVGRectElement;
  spans: SVGTSpanElement[];
  w: number;
  h: number;
  meta: boolean;
  lines: number;
  x: number;
  y: number;
}

export interface SkillsGraphHandle {
  /** The host changed size: lay the graph out again at the new width. */
  layout(): void;
  dispose(): void;
}

/** Draw the skills graph into `host` (a shadow root of its own) and play its run while on screen. */
export function mountSkillsGraph(host: HTMLElement): SkillsGraphHandle {
  const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const root = host.shadowRoot ?? host.attachShadow({ mode: "open" });
  root.innerHTML = `<style>${CSS}</style><svg role="img" aria-label="The author's skills as a program: AGENTS.md calls everyday skills (complete a task, answer a question, fix a bug), which lead to the meta-fix; fix a bug also leads to write tests first; the meta-fix and self-improvement lead to the update skill, which leads to write a skill"></svg>
      <div class="tip"></div>`;
  const svg = root.querySelector("svg")!;
  const tip = root.querySelector<HTMLDivElement>(".tip")!;
  let W = 0;
  let paths: Record<string, SVGPathElement> = {};
  let dot: SVGCircleElement | null = null;
  let playing = false;
  let raf = 0;
  let disposed = false;

  const el = <K extends keyof SVGElementTagNameMap>(
    tag: K,
    attrs: Record<string, string | number> = {},
    parent?: Element,
  ): SVGElementTagNameMap[K] => {
    const e = document.createElementNS(NS, tag);
    for (const k in attrs) e.setAttribute(k, String(attrs[k]));
    parent?.append(e);
    return e;
  };

  function layout() {
    const w = Math.round(host.clientWidth);
    if (!w || w === W) return;
    W = w;
    const narrow = W < 520,
      FS = narrow ? 12.5 : 13.5,
      LH = FS * 1.2;
    svg.replaceChildren();
    const edgeLayer = el("g", {}, svg),
      nodeLayer = el("g", {}, svg);

    // labels: one line when wide, wrapped at "|" when narrow
    const pos: Record<string, Placed> = {};
    for (const id in NODES) {
      const [label, meta] = NODES[id]!;
      const lines = narrow
        ? label.split("|")
        : [label.replace("|", label.includes("-|") ? "" : " ")];
      const g = el(
        "g",
        { class: "n" + (meta ? " meta" : "") + (id === "main" ? " root" : "") },
        nodeLayer,
      );
      const hit = el("rect", {}, g),
        t = el("text", { "font-size": FS }, g);
      const spans = lines.map((ln) => {
        const s = el("tspan", {}, t);
        s.textContent = ln.trim();
        return s;
      });
      const tw = Math.max(...spans.map((s) => s.getComputedTextLength())),
        h = lines.length * LH;
      pos[id] = {
        g,
        hit,
        spans,
        w: tw,
        h,
        meta: !!meta,
        lines: lines.length,
        x: 0,
        y: 0,
      };
    }

    // rows: the fixed labels at their fractions (kept inside the width), every row at the same gap
    const rowGap = narrow ? 38 : 46;
    let y = PAD;
    const spec: Record<string, number | readonly string[]> = {};
    for (const row of ROWS) {
      const rh = Math.max(...row.map(([id]) => pos[id]!.h));
      for (const [id, at] of row) {
        spec[id] = at;
        const p = pos[id]!;
        p.y = y + rh / 2;
        if (typeof at === "number")
          p.x = Math.min(Math.max(at * W, p.w / 2 + PAD), W - p.w / 2 - PAD);
      }
      y += rh + rowGap;
    }
    // then each centred label over (or under) the labels it joins
    for (const id of CENTRED) {
      const of = spec[id] as readonly string[];
      pos[id]!.x = of.reduce((sum, o) => sum + pos[o]!.x, 0) / of.length;
    }
    // and the whole picture centred in the width
    const all = Object.values(pos);
    const left = Math.min(...all.map((p) => p.x - p.w / 2)),
      right = Math.max(...all.map((p) => p.x + p.w / 2));
    const shift = (W - left - right) / 2;
    for (const p of all) p.x += shift;
    const H = y - rowGap + PAD;
    svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
    svg.setAttribute("height", String(H));

    for (const p of all) {
      p.spans.forEach((s, i) => {
        s.setAttribute("x", String(p.x));
        s.setAttribute("y", String(p.y + (i - (p.lines - 1) / 2) * LH));
      });
      const box = {
        x: p.x - p.w / 2 - 6,
        y: p.y - p.h / 2 - 4,
        width: p.w + 12,
        height: p.h + 8,
      };
      for (const [k, v] of Object.entries(box))
        p.hit.setAttribute(k, String(v));
    }

    // ports: an arrow between two labels in one column is a straight vertical line, centre to centre;
    // any other leaves (or lands) a little off centre, on the side of its other end — at most one per
    // side here, so the ports of one label never meet
    const STRAIGHT = 6;
    const port = (p: Placed, other: Placed) => {
      const dx = other.x - p.x;
      return Math.abs(dx) < STRAIGHT
        ? p.x
        : p.x + Math.sign(dx) * Math.min(p.w / 2 - 4, 12);
    };
    // an arc: one cubic with vertical tangents at both ends, so every arrow leaves its label straight
    // down and drops straight into the next (an S between two columns, a straight line within one),
    // ending in a small filled head pointing down.
    paths = {};
    const edges: { from: string; to: string; g: SVGGElement }[] = [];
    for (const [from, to] of EDGES) {
      const A = pos[from]!,
        B = pos[to]!,
        meta = A.meta && B.meta;
      const straight = Math.abs(A.x - B.x) < STRAIGHT;
      const x1 = straight ? A.x : port(A, B),
        y1 = A.y + A.h / 2 + 5;
      const x2 = straight ? A.x : port(B, A),
        y2 = B.y - B.h / 2 - 5;
      const by = y2 - 6,
        k = (by - y1) * 0.5; // the head's base, 6px above its tip at (x2, y2)
      const g = el("g", { class: "e" + (meta ? " meta" : "") }, edgeLayer);
      const p = el(
        "path",
        {
          class: "l",
          d: `M${x1} ${y1}C${x1} ${y1 + k} ${x2} ${by - k} ${x2} ${by}`,
        },
        g,
      );
      el(
        "path",
        { class: "a", d: `M${x2} ${y2}L${x2 - 3} ${by}L${x2 + 3} ${by}Z` },
        g,
      );
      paths[from + ">" + to] = p;
      edges.push({ from, to, g });
    }

    // hover: a node, its arrows and its neighbours; the tooltip names the real file
    const set = (id: string | null) => {
      svg.classList.toggle("hov", !!id);
      const near = new Set<string>(id ? [id] : []);
      for (const e of edges) {
        const on = !!id && (e.from === id || e.to === id);
        e.g.classList.toggle("on", on);
        if (on) near.add(e.from).add(e.to);
      }
      for (const k in pos)
        pos[k]!.g.classList.toggle("on", !!id && near.has(k));
      if (!id) {
        tip.classList.remove("on");
        return;
      }
      const [, , file, words] = NODES[id]!;
      const code = document.createElement("code");
      code.textContent = file;
      tip.replaceChildren(code, words);
      const p = pos[id]!,
        scale = svg.getBoundingClientRect().width / W,
        tw = tip.offsetWidth;
      tip.style.left =
        Math.min(Math.max(p.x * scale - tw / 2, 0), host.clientWidth - tw) +
        "px";
      tip.style.top = (p.y + p.h / 2 + 10) * scale + "px";
      tip.classList.add("on");
    };
    for (const id in pos) {
      pos[id]!.g.addEventListener("pointerenter", () => set(id));
      pos[id]!.g.addEventListener("pointerleave", () => set(null));
    }
    dot = el("circle", { class: "dot", r: 3, opacity: 0 }, svg);
  }

  // one run of execution flows down RUN, a hop at a time, then rests
  function play() {
    if (still || playing) return;
    playing = true;
    const HOP = 750,
      REST = 2600,
      n = RUN.length - 1,
      total = n * HOP + REST;
    let t0: number | undefined;
    const step = (now: number) => {
      if (!playing) return;
      t0 ??= now;
      const t = (now - t0) % total,
        i = Math.floor(t / HOP),
        path = paths[RUN[i]! + ">" + RUN[i + 1]!];
      if (i < n && path && dot) {
        const f = (t % HOP) / HOP,
          e = f * f * (3 - 2 * f),
          pt = path.getPointAtLength(path.getTotalLength() * e);
        dot.setAttribute("cx", String(pt.x));
        dot.setAttribute("cy", String(pt.y));
        dot.setAttribute(
          "opacity",
          String(
            i === 0
              ? Math.min(1, f * 5)
              : i === n - 1
                ? Math.min(1, (1 - f) * 5)
                : 1,
          ),
        );
      } else dot?.setAttribute("opacity", "0");
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
  }
  function stop() {
    playing = false;
    cancelAnimationFrame(raf);
    dot?.setAttribute("opacity", "0");
  }

  const watcher = createInViewWatcher(
    (es) => {
      for (const e of es) (e.isIntersecting ? play : stop)();
    },
    { threshold: 0.3 },
  );
  watcher.observe(host);
  layout();
  void document.fonts.ready.then(() => {
    if (disposed) return;
    W = 0;
    layout();
  });

  return {
    layout,
    dispose() {
      disposed = true;
      watcher.disconnect();
      stop();
    },
  };
}
