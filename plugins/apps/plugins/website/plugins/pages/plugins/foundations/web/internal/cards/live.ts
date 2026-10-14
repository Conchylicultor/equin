import { defineCard } from "../kit/types";

/**
 * Live data: a data set is declared once; when a row is added, only that change travels, through one connection
 * shared by every open tab, and each tab shows it. States: 0 before · 1 a task was added (the delta flows, tabs lit).
 */
export const liveCard = defineCard({
  width: "wide",
  states: 2,
  autoplay: { seq: [0, 1], every: [1800, 3200] },
  render: (k) => {
    const DX = 4;
    const DY = 34;
    const DW = 124;
    const DH = 96;
    const WX = 174;
    const WY = 58;
    const WW = 96;
    const WH = 48;
    const TX = 316;
    const TW = 162;
    const TH = 44;
    const TY = [4, 58, 112] as const;
    const [T0, T1, T2] = TY;
    // the declaration: fields, and what each can do
    let s =
      `<rect x="${DX}" y="${DY}" width="${DW}" height="${DH}" rx="${k.R.md}" class="k-plug"/>` +
      k.text(DX + 12, DY + 18, "tasks", "k-tl k-ta", "start");
    (
      [
        ["title", "text"],
        ["status", "filter · group"],
        ["updated", "sort"],
      ] as const
    ).forEach(([f, w], i) => {
      const y = DY + 40 + i * 18;
      s +=
        k.text(DX + 12, y, f, "k-tb", "start") +
        k.text(DX + DW - 10, y, w, "k-ts k-mute", "end");
    });
    // server → one shared connection: only the change is sent
    s += k.link(DX + DW, WY + WH / 2, WX, WY + WH / 2, {
      dir: "h",
      on: "1",
      send: true,
    });
    s += `<g data-in="1">${k.text((DX + DW + WX) / 2, WY + WH / 2 - 7, "+1 row", "k-ts k-ta")}</g>`;
    s += k.box(WX, WY, WW, WH, {
      title: "Shared worker",
      sub: "one connection",
    });
    // every open tab, the same size
    TY.forEach((y) => {
      s += k.link(WX + WW, WY + WH / 2, TX - 4, y + TH / 2, {
        dir: "h",
        on: "1",
        send: true,
        delay: k.DRAW,
      });
    });
    // tab 1: a list
    s += k.window(TX, T0, TW, TH, "Agent manager");
    s += `<g data-in="0">${k.text(TX + 10, T0 + 34, "Fix login bug", "k-ts", "start")}</g>`;
    s += `<g data-in="1"><rect x="${TX + 5}" y="${T0 + 23}" width="${TW - 10}" height="16" rx="3" class="k-lit"/>${k.text(TX + 10, T0 + 34, "Ship the new menu", "k-ts", "start")}</g>`;
    // tab 2: a board grouped by status
    s += k.window(TX, T1, TW, TH, "Pages · board");
    [0, 1, 2].forEach((c) => {
      s += `<rect x="${TX + 8 + c * 52}" y="${T1 + 26}" width="44" height="7" rx="2" class="k-box"/>`;
    });
    s += `<g data-in="1"><rect x="${TX + 8}" y="${T1 + 35}" width="44" height="7" rx="2" class="k-lit"/></g>`;
    // tab 3: a count
    s +=
      k.window(TX, T2, TW, TH, "Home") +
      k.text(TX + 10, T2 + 34, "Open tasks", "k-ts", "start");
    s += `<g data-in="0">${k.text(TX + TW - 10, T2 + 35, "3", "k-tl", "end")}</g><g data-in="1">${k.text(TX + TW - 10, T2 + 35, "4", "k-tl k-ta", "end")}</g>`;
    return k.svg(160, s);
  },
});
