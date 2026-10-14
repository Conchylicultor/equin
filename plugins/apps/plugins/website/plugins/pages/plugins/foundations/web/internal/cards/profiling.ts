import { defineCard } from "../kit/types";

/** [from ms, to ms, lane, name] */
const B = [
  [0, 160, 0, "Click handled"],
  [160, 1510, 1, "Builds the answer"],
  [210, 330, 2, "Load the user"],
  [380, 1330, 2, "Slow query"],
  [1360, 1470, 2, "Save the change"],
  [1540, 1800, 0, "Draw the screen"],
] as const;
const LANES = ["Browser", "Server", "Database"] as const;
const SLOW = 3;

export interface ProfilingData {
  kept: number;
}

/**
 * Profiling: one long bar stands out. Point at a bar to see what it is; click one to keep it; leaving the
 * picture goes back to the one kept (the slow query until you pick another).
 */
export const profilingCard = defineCard<ProfilingData>({
  states: B.length, // the bar shown in the details line
  start: SLOW,
  // the loop dwells on the slow query, then walks the other bars in time order
  autoplay: {
    seq: [3, 0, 1, 2, 4, 5],
    every: [3600, 1300, 1300, 1300, 1300, 1300],
  },
  render: (k) => {
    const x0 = 62;
    const sc = (298 - x0) / 1800;
    const X = (ms: number) => x0 + ms * sc;
    const ly = (l: number) => 20 + l * 28;
    const axis = ly(2) + 34;
    let s = "";
    LANES.forEach((t, l) => {
      s += k.text(4, ly(l) + 14, t, "k-tb", "start");
    });
    B.forEach(([a, b, l, name], i) => {
      const slow = i === SLOW;
      const w = (b - a) * sc;
      const rect = (cls: string) =>
        `<rect x="${X(a)}" y="${ly(l)}" width="${w}" height="20" rx="${k.R.sm - 2}" class="${cls}"/>`;
      s +=
        `<g data-act="pick" data-v="${i}" data-bar="${i}" role="button" tabindex="0" aria-label="${name}">` +
        rect(slow ? "k-lit k-pulse" : "k-box") +
        (slow
          ? k.text(X(a) + w / 2, ly(l) + 14, "slow query", "k-tb k-ta")
          : "") +
        `<g data-in="${i}">${rect("k-lit")}${rect("k-acc")}</g></g>`;
      const ms = `${(b - a).toLocaleString("en-US")} ms`;
      s += `<g data-in="${i}">${k.text(
        4,
        axis + 32,
        `<tspan class="k-tb">${name}</tspan> · ${LANES[l]} · ${ms}` +
          (slow ? `<tspan class="k-tb k-ta">  ← most of the wait</tspan>` : ""),
        "k-t",
        "start",
      )}</g>`;
    });
    s +=
      `<g class="k-faint"><path d="M${x0} ${axis} H${X(1800)}" class="k-ink"/>` +
      [0, 500, 1000, 1500]
        .map((ms) => `<path d="M${X(ms)} ${axis - 3} v6" class="k-ink"/>`)
        .join("") +
      `</g>`;
    s += [0, 500, 1000, 1500]
      .map((ms) =>
        k.text(X(ms), axis + 13, ms ? `${ms / 1000} s` : "0", "k-ts k-mute"),
      )
      .join("");
    return k.svg(axis + 38, s);
  },
  mount: (ctx) => {
    ctx.data.kept = SLOW;
    const svg = ctx.q<SVGSVGElement>("svg");
    const show = (i: number) => {
      if (ctx.state !== i) ctx.go(i);
    };
    ctx.on(svg, "mouseover", (e) => {
      if (!(e.target instanceof Element)) return;
      const bar = e.target.closest<SVGElement>("[data-bar]");
      if (bar) {
        ctx.hold();
        show(Number(bar.dataset.bar));
      }
    });
    ctx.on(svg, "mouseleave", () => show(ctx.data.kept));
  },
  actions: {
    pick: (ctx, el) => {
      ctx.data.kept = Number(el.dataset.v);
      ctx.go(ctx.data.kept);
    },
  },
});
