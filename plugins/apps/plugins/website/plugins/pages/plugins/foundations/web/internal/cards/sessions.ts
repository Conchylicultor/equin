import { defineCard } from "../kit/types";
import "./sessions.css";

const FH = 146;
const AX = 12;
const AY = 26;
const AW = 116;
const AH = 116;
const SX = 170;
const SW = 122;
const SH = 32;
const SY = 30;
const SSTEP = 38;
const ROW_WIDTHS = [62, 48, 56] as const;
const TYPED = [
  [0, 66],
  [8, 46],
] as const;

/**
 * Isolated agent sessions: the agents' sessions run beside equin, not inside it. When equin goes
 * down, its window dims and its links to the sessions drop, but every session keeps typing; when it comes back, it
 * reconnects to them. States: 0 equin up, linked to the sessions · 1 equin down, the sessions still working. Loops.
 * Every piece is drawn once and takes its look from data-on; the typing loops on its own in both states.
 */
export const sessionsCard = defineCard({
  states: 2,
  autoplay: { seq: [0, 1], every: [2600, 3600], lead: 1600 },
  render: (k) => {
    // two columns side by side on the same machine: the app, and the sessions it starts but does not hold
    let s =
      k.text(AX, 18, "the app", "k-cap", "start") +
      k.text(SX, 18, "agent sessions", "k-cap", "start");
    // equin: its window, one row per running agent; dimmed while it is down
    let eq = k.window(AX, AY, AW, AH, "equin");
    let links = "";
    [0, 1, 2].forEach((i) => {
      const ry = AY + 34 + i * 30;
      const sy = SY + i * SSTEP + SH / 2;
      eq +=
        `<circle cx="${AX + 14}" cy="${ry}" r="3" class="k-accf"/>` +
        k.codeLines(AX + 24, ry, [[0, ROW_WIDTHS[i] ?? 0]]);
      links += k.link(AX + AW, ry, SX, sy, {
        dir: "h",
        in: "0",
        delay: i * 0.12,
      });
    });
    s += `<g data-on="1" class="ss-eq">${eq}</g>`;
    // its links to the sessions: gone while it is down, drawn again as it reconnects
    s += links;
    // the sessions: separate processes, each typing away on its own, whatever equin is doing
    [0, 1, 2].forEach((i) => {
      const y = SY + i * SSTEP;
      const cy = y + SH / 2;
      const d = i * 1.1;
      s +=
        `<rect x="${SX}" y="${y}" width="${SW}" height="${SH}" rx="${k.R.md}" class="k-box"/>` +
        k.icon("terminal", SX + 13, cy, 12, "k-ta") +
        TYPED.map(
          ([dy, w], j) =>
            `<line x1="${SX + 26}" x2="${SX + 26 + w}" y1="${cy - 4 + dy}" y2="${cy - 4 + dy}" class="k-code ss-type" style="--d:${(d + j * 0.6).toFixed(1)}s"/>`,
        ).join("") +
        k.spinner(SX + SW - 12, cy, 5);
    });
    return k.svg(FH, s);
  },
});
