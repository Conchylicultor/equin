import { defineCard } from "../kit/types";

const AW = 54;
const AH = 26;
const AY = [14, 58, 102] as const;
const CX = 84;
const CW = 92;
const CH = 44;
const SX = 206;
const SW = 96;
const SH = 26;
const SY = [14, 58, 102] as const;
const STEPS = [
  ["Build", "the app"],
  ["Check", "every check"],
  ["Ship", "to main"],
] as const;
const H = 132;
const CY = H / 2 - CH / 2 + 2;

/**
 * Agent CLI: whichever agent it is, it goes through the one command line, which runs the same steps in the same
 * order. Each agent takes its turn; its path and the steps light up, one after the other.
 */
export const cliCard = defineCard({
  states: 3, // agent i's turn
  autoplay: { seq: [0, 1, 2], every: 2400, lead: 800 },
  render: (k) => {
    const cliMid = CY + CH / 2;
    const agent = (i: 0 | 1 | 2) =>
      `<rect x="0" y="${AY[i]}" width="${AW}" height="${AH}" rx="${AH / 2}" class="k-box"/>` +
      k.text(AW / 2, AY[i] + AH / 2 + 3.5, `Agent ${i + 1}`, "k-tb");
    let s = "";
    // the agents, each with its own way into the CLI (its own entry on its edge, so a lit arrow is never under an unlit one),
    // drawn once: an agent lights on its turn
    ([0, 1, 2] as const).forEach((i) => {
      s += `<g data-on="${i}" class="k-sw k-sw-dim">${k.link(AW, AY[i] + AH / 2, CX, cliMid + (i - 1) * 10, { dir: "h" })}${agent(i)}</g>`;
    });
    // the one entry point
    s +=
      `<rect x="${CX}" y="${CY}" width="${CW}" height="${CH}" rx="${k.R.md}" class="k-lit"/>` +
      k.icon("terminal", CX + 14, CY + 16, 12, "k-ta") +
      k.text(CX + 25, CY + 20, "Agent CLI", "k-tb k-ta", "start") +
      k.text(CX + CW / 2, CY + 34, "the only way in", "k-ts k-mute");
    s += k.link(CX + CW, cliMid, SX, SY[0] + SH / 2, { dir: "h", lit: true });
    // the same steps, in the same order, every time; replayed on each agent's turn
    STEPS.forEach(([t, sub], j) => {
      const y = SY[j] ?? 0;
      s +=
        `<rect x="${SX}" y="${y}" width="${SW}" height="${SH + 6}" rx="${k.R.md}" class="k-box"/>` +
        k.text(SX + 22, y + 13, t, "k-tb", "start") +
        k.text(SX + 22, y + 25, sub, "k-ts k-mute", "start") +
        k.text(SX + 11, y + 19, `${j + 1}`, "k-ts k-mute");
      const next = SY[j + 1];
      if (j < 2 && next !== undefined)
        s += `<path d="M${SX + SW / 2} ${y + SH + 6} V${next}" class="k-ink k-faint"/>`;
    });
    s +=
      `<g data-in="0 1 2" data-replay>` +
      STEPS.map(
        (_, j) =>
          `<g class="k-in" style="--d:${(0.35 + j * 0.5).toFixed(2)}s"><rect x="${SX}" y="${SY[j] ?? 0}" width="${SW}" height="${SH + 6}" rx="${k.R.md}" class="k-acc"/>` +
          k.check(SX + SW - 22, (SY[j] ?? 0) + 16, 1) +
          `</g>`,
      ).join("") +
      `</g>`;
    return k.svg(SY[2] + SH + 8, s);
  },
});
