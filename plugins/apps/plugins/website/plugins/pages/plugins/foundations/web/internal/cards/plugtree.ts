import { curve } from "../kit/draw";
import { defineCard, type CardCtx, type KitElement } from "../kit/types";

type Piece = readonly [id: string, label: string];
type Rect = readonly [x: number, y: number, w: number, h: number];
type Kind = "uses" | "plugs";
type Edge = readonly [a: string, b: string, kind: Kind];

export interface PlugtreeData {
  open: string[];
  hov: string;
}
type Ctx = CardCtx<PlugtreeData>;

const APPS: readonly (readonly [
  id: string,
  label: string,
  kids: readonly Piece[],
])[] = [
  [
    "mail",
    "Mail",
    [
      ["inbox", "Inbox"],
      ["compose", "Compose"],
      ["newmail", "New-mail button"],
    ],
  ],
  [
    "music",
    "Music",
    [
      ["piano", "Piano"],
      ["play", "Play button"],
    ],
  ],
];
const SHELL: readonly Piece[] = [
  ["tabs", "Tabs"],
  ["toolbar", "Toolbar"],
  ["theme", "Theme"],
];
const EDGES: readonly Edge[] = [
  ["newmail", "toolbar", "plugs"],
  ["play", "toolbar", "plugs"],
  ["mail", "data", "uses"],
  ["music", "data", "uses"],
];
const KIDS: Record<string, readonly Piece[]> = Object.fromEntries(
  APPS.map(([id, , kids]) => [id, kids]),
);
const OWNER: Record<string, string> = Object.fromEntries(
  APPS.flatMap(([id, , kids]) => kids.map(([c]) => [c, id])),
);
const LABEL: Record<string, string> = Object.fromEntries([
  ["equin", "equin"],
  ["apps", "Apps"],
  ["shell", "Shell"],
  ["data", "Data"],
  ...APPS.map(([id, l]) => [id, l]),
  ...APPS.flatMap(([, , kids]) => kids),
  ...SHELL,
]);
const HEADS = new Set([
  "equin",
  "apps",
  "shell",
  "data",
  ...APPS.map(([id]) => id),
]);
const ORDER = [
  "equin",
  "apps",
  ...APPS.flatMap(([id, , kids]) => [id, ...kids.map(([c]) => c)]),
  "shell",
  ...SHELL.map(([c]) => c),
  "data",
];
// every edge that can show: a piece inside a closed app is stood in for by its app
const ALL_EDGES: Edge[] = [
  ...new Map<string, Edge>(
    EDGES.flatMap(([a, b, kind]): Edge[] => {
      const owner = OWNER[a];
      return [[a, b, kind], ...(owner ? [[owner, b, kind] as const] : [])];
    }).map((e) => [e[0] + ">" + e[1], e] as const),
  ).values(),
];

// where every plugin sits for a set of open apps: id → [x, y, w, h] (absent = hidden), and the picture's height
const geom = (open: readonly string[]): [Record<string, Rect>, number] => {
  const G: Record<string, Rect> = {};
  const HEAD = 30;
  const STEP = 30;
  const stack = (ids: readonly Piece[], x: number, y: number, w: number) => {
    ids.forEach(([id], i) => {
      G[id] = [x, y + i * STEP, w, 24];
    });
    return y + ids.length * STEP;
  };
  let y = 64;
  APPS.forEach(([id, , kids]) => {
    const bottom = open.includes(id) ? stack(kids, 40, y + HEAD, 186) : y + 32;
    G[id] = [30, y, 206, bottom - y];
    y = bottom + 8;
  });
  const apps: Rect = [20, 36, 226, y + 2 - 36];
  G.apps = apps;
  const sb = stack(SHELL, 268, 36 + HEAD, 184);
  G.shell = [258, 36, 204, sb - 36];
  const data: Rect = [258, sb + 10, 204, 32];
  G.data = data;
  const bottom = Math.max(apps[1] + apps[3], data[1] + data[3]) + 12;
  G.equin = [8, 8, 466, bottom - 8];
  return [G, bottom + 26];
};

// lay every node and edge out for `open`, in place; the pieces of a just-opened app fade in one after another
const layout = (ctx: Ctx, open: readonly string[], opened = "") => {
  const svg = ctx.q<SVGSVGElement>("svg");
  const [G, H] = geom(open);
  ctx.qa<SVGGElement>("svg [data-node]").forEach((n) => {
    const id = n.dataset.node ?? "";
    const g = G[id];
    n.classList.toggle("k-off", !g);
    if (!g) {
      n.classList.remove("k-enter");
      return;
    }
    const [x, y, w, h] = g;
    const [rect, label, toggle] = Array.from(n.children);
    if (!rect || !label) return;
    Object.entries({ x, y, width: w, height: h }).forEach(([a, v]) => {
      rect.setAttribute(a, String(v));
    });
    const ty = HEADS.has(id) ? y + (h > 40 ? 19 : h / 2 + 4) : y + h / 2 + 4;
    label.setAttribute("x", String(HEADS.has(id) ? x + 10 : x + w / 2));
    label.setAttribute("y", String(ty));
    if (toggle) {
      toggle.setAttribute("x", String(x + w - 10));
      toggle.setAttribute("y", String(ty));
      toggle.textContent = open.includes(id) ? "−" : "+";
    }
    if (OWNER[id] === opened) {
      n.style.setProperty(
        "--d",
        `${(KIDS[opened] ?? []).findIndex(([c]) => c === id) * 0.05}s`,
      );
      n.classList.add("k-enter");
    }
  });
  const shown = new Set(
    EDGES.map(([a, b]) => (G[a] ? a : (OWNER[a] ?? a)) + ">" + b),
  );
  ctx.qa<SVGGElement>("svg [data-a]").forEach((e) => {
    const { a = "", b = "" } = e.dataset;
    const on = shown.has(a + ">" + b);
    e.classList.toggle("k-off", !on);
    if (!on) return;
    const ga = G[a];
    const gb = G[b];
    // the link's stroke, the cover it draws itself with, its arrowhead
    const [line, cover, head] = e.children;
    if (!ga || !gb || !line || !cover || !head) return;
    const [ax, ay, aw, ah] = ga;
    const [bx, by, , bh] = gb;
    const c = curve(
      ax + aw,
      ay + (ah > 40 ? 15 : ah / 2),
      bx,
      by + (bh > 40 ? 15 : bh / 2),
      "h",
    );
    line.setAttribute("d", c.d);
    cover.setAttribute("d", c.d);
    head.setAttribute("d", c.head);
  });
  ctx.q("svg .k-lg").setAttribute("transform", `translate(0 ${H - 10})`);
  svg.setAttribute("viewBox", `0 0 ${svg.viewBox.baseVal.width} ${H}`);
};

const toggle = (ctx: Ctx, id: string) => {
  const was = ctx.data.open;
  ctx.data.open = was.includes(id) ? was.filter((x) => x !== id) : [...was, id];
  layout(ctx, ctx.data.open, ctx.data.open.includes(id) ? id : "");
};

const nodeOf = (e: Event): KitElement | null =>
  e.target instanceof Element
    ? e.target.closest<SVGElement>("[data-node]")
    : null;

/**
 * Everything is a plugin: plugins inside plugins, the same box at every depth. Click an app to open or close it;
 * point at a plugin to see what it uses and what it plugs into. Every node is drawn once; opening an app only
 * moves and resizes the nodes in place (never rebuilds them), so hover survives a click and nothing flickers.
 */
export const plugtreeCard = defineCard<PlugtreeData>({
  width: "wide",
  // the skeleton: every node and every possible edge, placed by layout() on mount
  render: (k) => {
    const nodes = ORDER.map((id) => {
      const app = !!KIDS[id];
      return (
        `<g data-node="${id}"${app ? ` data-act="app" role="button" tabindex="0" aria-label="Open or close ${LABEL[id]}"` : ""}>` +
        `<rect rx="${k.R.md}" class="k-box"/>${k.text(0, 0, LABEL[id] ?? "", HEADS.has(id) ? "k-tl" : "k-tm", HEADS.has(id) ? "start" : "middle")}` +
        (app ? k.text(0, 0, "", "k-tl k-mute", "end") : "") +
        `</g>`
      );
    }).join("");
    const edges = ALL_EDGES.map(([a, b, kind]) =>
      k.link(0, 0, 1, 0, { kind, dir: "h", a, b }),
    ).join("");
    const legend = `<g class="k-lg">${k.legend(8, 0, [
      ["uses", "uses"],
      ["plugs", "plugs into"],
    ])}</g>`;
    return k.svg(400, nodes + edges + legend, "k-edges-hover");
  },
  mount: (ctx) => {
    ctx.data.open = ["mail"];
    ctx.data.hov = "";
    layout(ctx, ctx.data.open);
    const svg = ctx.q<SVGSVGElement>("svg");
    const point = (id: string) => {
      if (id !== ctx.data.hov) {
        ctx.data.hov = id;
        ctx.highlight(id);
      }
    };
    ctx.on(svg, "mouseover", (e) => {
      point(nodeOf(e)?.dataset.node ?? "");
    });
    ctx.on(svg, "mouseleave", () => {
      point("");
    });
    ctx.on(svg, "focusin", (e) => {
      const n = nodeOf(e);
      if (n) point(n.dataset.node ?? "");
    });
  },
  actions: {
    app: (ctx, el) => {
      toggle(ctx, el.dataset.node ?? "");
      ctx.highlight(ctx.data.hov); // the edges moved: relight what is pointed at
    },
  },
});
