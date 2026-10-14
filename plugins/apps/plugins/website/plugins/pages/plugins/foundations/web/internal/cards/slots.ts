import type { LucideName } from "../kit/draw";
import { defineCard } from "../kit/types";
import "./slots.css";

/**
 * How plugins connect: the toolbar plugin uses three plugins, and leaves an
 * empty toolbar that Build, Improve and yours each plug a button into, one at a
 * time. Each new link draws itself; links already plugged stay still.
 */
export const slotsCard = defineCard({
  states: 4, // 0 empty toolbar · 1 Build plugged in · 2 + Improve · 3 + your plugin
  autoplay: { seq: [0, 1, 2, 3], every: 1700 },
  render: (k) => {
    // uses · toolbar plugin · plugs in
    const W = 88;
    const H = 48;
    const X = [6, 107, 208] as const;
    const cx = X.map((x) => x + W / 2) as [number, number, number];
    const Y = [6, 92, 178] as const;
    const TW = 72;
    const TH = 22;
    const tx = cx[1] - TW / 2;
    const ty = Y[1] + 20;
    const icy = ty + TH / 2;
    const ix = [tx + 14, tx + 36, tx + 58] as const;
    let s = "";
    // what the toolbar plugin itself uses
    (["Buttons", "Tooltips", "Theme"] as const).forEach((t, i) => {
      s +=
        k.box(X[i] ?? 0, Y[0], W, H, { title: t }) +
        k.link(cx[1], Y[1], cx[i] ?? 0, Y[0] + H);
    });
    // the toolbar plugin: an empty toolbar with room for three buttons
    s +=
      k.box(X[1], Y[1], W, H) +
      k.text(cx[1], Y[1] + 14, "Toolbar plugin", "k-tb");
    s += `<rect x="${tx}" y="${ty}" width="${TW}" height="${TH}" rx="${k.R.sm}" class="k-slot"/>`;
    s += `<g data-in="0">${k.text(cx[1], icy + 3.5, "empty toolbar", "k-ts")}</g>`;
    // a contributor: its name, and the button it brings
    const contrib = (i: 0 | 1, t: string, icon: LucideName) =>
      k.box(X[i], Y[2], W, H) +
      k.text(cx[i], Y[2] + 14, t, "k-tb") +
      `<rect x="${cx[i] - 13}" y="${Y[2] + 20}" width="26" height="22" rx="${k.R.sm}" class="k-box"/>` +
      k.icon(icon, cx[i], Y[2] + 31, 13);
    s +=
      contrib(0, "Build plugin", "hammer") +
      contrib(1, "Improve plugin", "lightbulb");
    // your plugin: one box, a dashed placeholder until it is written, then solid with its button
    s +=
      `<g data-on="3" class="sl-yours">${k.box(X[2], Y[2], W, H)}</g>` +
      `<g data-in="0 1 2">${k.text(cx[2], Y[2] + H / 2 + 3.5, "Your plugin", "k-ts k-mute")}</g>` +
      `<g data-in="3">${k.text(cx[2], Y[2] + 14, "Your plugin", "k-tb")}` +
      `<rect x="${cx[2] - 13}" y="${Y[2] + 20}" width="26" height="22" rx="${k.R.sm}" class="k-box"/>${k.icon("star", cx[2], Y[2] + 31, 13)}</g>`;
    // plugging in: the link draws itself, then the button shows in the toolbar
    const plug = (i: 0 | 1 | 2, icon: LucideName, states: string) =>
      k.link(cx[i], Y[2], ix[i], Y[1] + H, { kind: "plugs", in: states }) +
      `<g data-in="${states}"><g class="k-in" style="--d:.6s">${k.icon(icon, ix[i], icy, 13, "k-ta")}</g></g>`;
    s +=
      plug(0, "hammer", "1 2 3") +
      plug(1, "lightbulb", "2 3") +
      plug(2, "star", "3");
    s += k.legend(6, 244, [
      ["uses", "uses"],
      ["plugs", "plugs into"],
    ]);
    return k.svg(252, s);
  },
});
