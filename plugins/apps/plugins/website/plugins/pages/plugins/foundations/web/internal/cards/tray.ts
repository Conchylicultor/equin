import type { LucideName } from "../kit/draw";
import { defineCard } from "../kit/types";

const APPS: readonly (readonly [string, LucideName])[] = [
  ["Agents", "bot"],
  ["Pages", "layers"],
  ["Mail", "bell"],
  ["Music", "play"],
  ["Places", "star"],
  ["Deploy", "hammer"],
  ["Events", "clock"],
  ["Studio", "code"],
];
const PICK = 1; // Pages
const P = { x: 156, y: 32, w: 142, h: 100 };
const tile = (i: number) => {
  const col = i % 4;
  const row = Math.floor(i / 4);
  const cw = (P.w - 12) / 4;
  return { cx: P.x + 6 + cw / 2 + col * cw, y: P.y + 38 + row * 30 };
};
/** The Dock: the computer's own apps, and a slot the picked app takes as an app of its own. */
const DOCK: readonly (readonly [LucideName, boolean])[] = [
  ["box", false],
  ["bell", false],
  ["play", false],
  ["layers", true],
];
const DY = 158;

/**
 * Mac & Linux integration: equin's icon in the menu bar (drawn as the Mac's) opens a panel over whatever is on
 * screen — a task field and every app — and an app picked there opens as a native app: its own window, and its own
 * icon in the Dock.
 * States: 0 closed (the icon pulses) · 1 panel open · 2 an app picked · 3 the app's own window and Dock icon, panel hidden.
 */
export const trayCard = defineCard({
  states: 4,
  autoplay: { seq: [0, 1, 2, 3], every: [1600, 2200, 700, 2600] },
  render: (k) => {
    // the menu bar: the clock and equin's icon among the status items on the right
    let s =
      k.box(4, 4, 294, 22, { r: k.R.sm }) +
      k.text(292, 18.5, "9:41", "k-ts k-mute", "end");
    s += k.icon("bell", 228, 15, 11, "k-mute");
    s +=
      `<g data-act="tray" role="button" tabindex="0" aria-label="equin"><rect x="245" y="7" width="20" height="16" rx="4" class="k-hit"/>` +
      `<rect x="245" y="7" width="20" height="16" rx="4" class="k-lit" data-in="1 2"/>` +
      `<circle cx="255" cy="15" r="5.5" class="k-ring" data-in="0"/>` +
      `<path d="M255 15 a1.4 1.4 0 0 1 2.8 0 a2.8 2.8 0 0 1 -5.6 0 a4.2 4.2 0 0 1 8.4 0" class="k-ink" fill="none"/></g>`;
    // the app picked, in its own window
    const body = k.codeLines(
      18,
      68,
      [
        [0, 120],
        [0, 96],
        [0, 110],
        [10, 80],
        [10, 92],
      ],
      12,
    );
    s += `<g data-in="3">${k.window(8, 36, 178, 112, "", body)}</g>`;
    // the panel, under the icon
    let pop =
      k.box(P.x, P.y, P.w, P.h, { r: k.R.lg }) +
      `<rect x="${P.x + 8}" y="${P.y + 8}" width="${P.w - 16}" height="20" rx="${k.R.sm}" class="k-box"/>`;
    APPS.forEach(([name, icon], i) => {
      const { cx, y } = tile(i);
      pop +=
        `<g${i === PICK ? ` data-act="open" role="button" tabindex="0" aria-label="${name}"` : ""}>` +
        `<rect x="${cx - 11}" y="${y}" width="22" height="22" rx="${k.R.sm}" class="k-box"/>` +
        (i === PICK
          ? `<rect x="${cx - 11}" y="${y}" width="22" height="22" rx="${k.R.sm}" class="k-lit" data-in="2"/>`
          : "") +
        k.icon(icon, cx, y + 11, 12) +
        `</g>`;
    });
    s += `<g data-in="1 2">${pop}</g>`;
    // the Dock, the picked app's icon arriving with its running dot
    s += `<rect x="${151 - 62}" y="${DY}" width="124" height="28" rx="${k.R.lg}" class="k-box"/>`;
    DOCK.forEach(([icon, picked], i) => {
      const cx = 151 - 42 + i * 28;
      const tileSvg =
        `<rect x="${cx - 10}" y="${DY + 4}" width="20" height="20" rx="${k.R.sm}" class="${picked ? "k-lit" : "k-box"}"/>` +
        k.icon(icon, cx, DY + 14, 11, picked ? "k-ta" : "");
      s += picked
        ? `<g data-in="3">${tileSvg}<circle cx="${cx}" cy="${DY + 26.5}" r="1.3" class="k-accf" stroke="none"/></g>`
        : tileSvg;
    });
    return k.svg(190, s);
  },
  actions: {
    tray: (ctx) => ctx.go(ctx.state === 1 || ctx.state === 2 ? 0 : 1),
    open: (ctx) =>
      ctx.run([
        [0, 2],
        [500, 3],
      ]),
  },
});
