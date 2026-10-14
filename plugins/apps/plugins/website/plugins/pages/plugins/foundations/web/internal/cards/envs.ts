import { defineCard } from "../kit/types";
import "./envs.css";

const FW = 146;
const FH = 112;
const FY = 4;
const IW = 40;
const GAP = 6;
const IY = FY + 44;
const SY = FY + FH - 12;

/**
 * Isolated environments: your app and an agent's copy, each its own code, server and database at its own address.
 * The agent changes its code and breaks its copy; yours keeps working. Loops.
 */
export const envsCard = defineCard({
  states: 3, // 0 both working · 1 the agent changes its code · 2 its copy breaks, yours is untouched
  autoplay: { seq: [0, 1, 2], every: [1800, 800, 2800], lead: 1000 },
  render: (k) => {
    const cell = (x: number, cls = "k-box") =>
      `<rect x="${x}" y="${IY}" width="${IW}" height="30" rx="${k.R.sm}" class="${cls}"/>`;
    const label = (x: number, t: string, cls = "k-t") =>
      k.text(x + IW / 2, IY + 19, t, cls);
    const copy = (x: number, title: string, addr: string, agent: boolean) => {
      const x0 = x + (FW - (3 * IW + 2 * GAP)) / 2;
      const xs = x0 + IW + GAP;
      const xd = xs + IW + GAP;
      let s =
        `<rect x="${x}" y="${FY}" width="${FW}" height="${FH}" rx="${k.R.lg}" class="k-ink"/>` +
        k.text(x + FW / 2, FY + 18, title, "k-tb") +
        k.text(x + FW / 2, FY + 31, addr, "k-ts k-mute");
      s += agent ? `<g data-on="1 2" class="k-sw">${cell(x0)}</g>` : cell(x0);
      s += label(x0, "code");
      s += agent
        ? `<g data-on="2" class="k-sw ev-down">${cell(xs)}</g><g data-in="0 1">${label(xs, "server")}</g><g data-in="2">${label(xs, "✕ down", "k-ts k-ta")}</g>`
        : cell(xs) + label(xs, "server");
      s += k.cylinder(xd, IY + 4, IW, "data");
      if (agent)
        s += `<g data-in="1">${k.token(`M${x0 + IW / 2} ${FY + 36} V${IY + 15}`)}</g>`;
      return s;
    };
    const mid = FW / 2;
    const ax = 302 - FW;
    let s =
      copy(0, "Your app", "mail.localhost", false) +
      `<g data-in="0 1">${k.text(mid, SY, "✓ working", "k-ts k-mute")}</g><g data-in="2">${k.text(mid, SY, "✓ still working", "k-tb")}</g>`;
    s +=
      copy(ax, "Agent's copy", "fix-login.localhost", true) +
      `<g data-in="0">${k.text(ax + mid, SY, "✓ working", "k-ts k-mute")}</g>` +
      `<g data-in="1">${k.text(ax + mid, SY, "changing its code…", "k-ts k-ta")}</g>` +
      `<g data-in="2">${k.text(ax + mid, SY, "✕ broken", "k-tb k-ta")}</g>`;
    return k.svg(FY + FH + 6, s);
  },
});
