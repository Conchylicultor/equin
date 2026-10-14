import { defineCard } from "../kit/types";

/** Standalone app builds: pick an app, the plugins it is made of light up, and that app comes out. */
export const composeCard = defineCard({
  states: 2, // 0 agent manager · 1 music app
  autoplay: { seq: [0, 1], every: 3400 },
  render: (k) => {
    // [label, col, row, the builds it belongs to]
    const N = [
      ["tasks", 0, 0, "0"],
      ["agents", 1, 0, "0"],
      ["music", 2, 0, "1"],
      ["pages", 0, 1, "0"],
      ["review", 1, 1, "0"],
      ["piano", 2, 1, "1"],
      ["files", 0, 2, "0"],
      ["search", 1, 2, "0"],
      ["player", 2, 2, "1"],
      ["login", 0, 3, "0"],
      ["theme", 1, 3, "0 1"],
      ["sound", 2, 3, "1"],
      ["jobs", 0, 4, "0"],
      ["database", 1, 4, "0 1"],
      ["live data", 2, 4, "0 1"],
    ] as const;
    const W = 55;
    const H = 22;
    const px = (c: number) => 4 + c * 60;
    const py = (r: number) => 40 + r * 28;
    let s = k.text(4, 19, "build", "k-cap", "start");
    s += k.chip(42, 4, 100, "Agent manager", {
      act: "pick",
      on: "0",
      attrs: 'data-v="0"',
    });
    s += k.chip(148, 4, 78, "Music app", {
      act: "pick",
      on: "1",
      attrs: 'data-v="1"',
    });
    // every plugin; the ones in the picked build light up
    N.forEach(([t, c, r, w]) => {
      const x = px(c);
      const y = py(r);
      const rect = (cls: string) =>
        `<rect x="${x}" y="${y}" width="${W}" height="${H}" rx="${k.R.sm}" class="${cls}"/>`;
      s += rect("k-box") + k.text(x + W / 2, y + 15, t, "k-t k-mute");
      s += `<g data-in="${w}">${rect("k-box")}${rect("k-lit")}${k.text(x + W / 2, y + 15, t, "k-tb k-ta")}</g>`;
    });
    s += k.link(184, 100, 206, 100, { dir: "h" });
    // the app it becomes
    const ax = 212;
    const ay = 42;
    const aw = 86;
    const ah = 98;
    s += k.window(ax, ay, aw, ah, "");
    const rows = [0, 1, 2, 3]
      .map(
        (j) =>
          `<rect x="${ax + 34}" y="${ay + 30 + j * 16}" width="8" height="7" rx="2" class="k-accf"/>` +
          `<line x1="${ax + 47}" x2="${ax + 78 - (j % 2) * 12}" y1="${ay + 33.5 + j * 16}" y2="${ay + 33.5 + j * 16}" class="k-ink"/>`,
      )
      .join("");
    s += `<g data-in="0"><rect x="${ax + 6}" y="${ay + 25}" width="20" height="${ah - 31}" rx="3" class="k-lit"/>${rows}</g>`;
    // the music app: a piano roll on top, a small keyboard under it
    const rx = ax + 8;
    const rw = 70;
    const ry = ay + 28;
    const rh = 34;
    const ky = ry + rh + 4;
    const kh = 22;
    // the roll runs down into the keys: one column per white key, each note a bar in its key's column
    const lanes = [1, 2, 3, 4, 5, 6]
      .map(
        (j) =>
          `<path d="M${rx + j * 10} ${ry} V${ry + rh}" class="k-ink k-faint"/>`,
      )
      .join("");
    const notes = (
      [
        [0, 22, 10],
        [2, 4, 12],
        [3, 14, 8],
        [4, 0, 10],
        [5, 18, 14],
        [6, 6, 9],
      ] as const
    )
      .map(
        ([col, y, h]) =>
          `<rect x="${rx + col * 10 + 2}" y="${ry + y}" width="6" height="${h}" rx="1.5" class="k-accf"/>`,
      )
      .join("");
    const roll = `<rect x="${rx}" y="${ry}" width="${rw}" height="${rh}" rx="2" class="k-box"/>${lanes}${notes}`;
    const keys =
      Array.from(
        { length: 7 },
        (_, j) =>
          `<rect x="${rx + j * 10}" y="${ky}" width="10" height="${kh}" class="k-box"/>`,
      ).join("") +
      [0, 1, 3, 4, 5]
        .map(
          (j) =>
            `<rect x="${rx + 6.5 + j * 10}" y="${ky}" width="7" height="${kh * 0.58}" class="k-accf"/>`,
        )
        .join("");
    s += `<g data-in="1">${roll}${keys}</g>`;
    s += `<g data-in="0">${k.text(ax + aw / 2, ay + ah + 18, "Agent manager", "k-tb")}${k.text(ax + aw / 2, ay + ah + 31, "11 plugins", "k-ts k-mute")}</g>`;
    s += `<g data-in="1">${k.text(ax + aw / 2, ay + ah + 18, "Music app", "k-tb")}${k.text(ax + aw / 2, ay + ah + 31, "7 plugins", "k-ts k-mute")}</g>`;
    return k.svg(178, s);
  },
  actions: { pick: (ctx, el) => ctx.go(Number(el.dataset.v)) },
});
