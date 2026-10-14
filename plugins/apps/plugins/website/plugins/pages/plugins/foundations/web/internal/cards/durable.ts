import { defineCard, type CardCtx } from "../kit/types";
import "./durable.css";

const SW = 100;
const SH = 40;
const OY = 8;
const NY = 104;
const JX = 190;
const JY = 52;
const JW = 112;
const JH = 48;
const BW = JW - 24;
const SEQ = [
  [0, 0],
  [900, 1],
  [2200, 2],
  [3400, 3],
  [4000, 4],
] as const;
const play = (ctx: CardCtx<Record<string, never>>) => {
  ctx.run(SEQ);
  ctx.fire("bar");
};

const at = (states: string, body: string, cls = "") =>
  `<g data-in="${states}"${cls ? ` class="${cls}"` : ""}>${body}</g>`;

/**
 * Durable jobs: the old server launches a long job, gets replaced while the job
 * keeps running, and the new server receives its result, on a loop.
 */
export const durableCard = defineCard({
  states: 5, // 0 the old server's job runs · 1 old stopping, new starting · 2 new running · 3 the result travels · 4 received
  // each tick replays the whole story (the bar's growth is one SMIL timeline, so it is a run, not a seq)
  autoplay: { every: 5600, lead: 900, step: (ctx) => play(ctx) },
  // the two servers are drawn once and restyled by the card's state (data-s on the root), never redrawn, so a step
  // only swaps a status word: the boxes themselves never re-enter
  render: (k) => {
    // a server: its box and name for good, then one status word per set of states
    const server = (
      cls: string,
      y: number,
      title: string,
      statuses: readonly (readonly [string, string, boolean?])[],
    ) =>
      `<g class="du-srv ${cls}"><rect x="0" y="${y}" width="${SW}" height="${SH}" rx="${k.R.md}" class="k-box du-frame"/>` +
      `<rect x="0" y="${y}" width="${SW}" height="${SH}" rx="${k.R.md}" class="k-lit du-lit"/>` +
      k.text(SW / 2, y + SH / 2 - 2, title, "k-tb") +
      statuses
        .map(([st, t, lit]) =>
          at(
            st,
            k.text(
              SW / 2,
              y + SH / 2 + 11,
              t,
              lit ? "k-ts k-ta" : "k-ts k-mute",
            ),
          ),
        )
        .join("") +
      `</g>`;
    let s =
      `<g class="k-mute">${k.link(SW, OY + SH / 2, JX, JY + JH / 2 - 8, { dir: "h" })}</g>` +
      k.text(145, 22, "launched it", "k-ts k-mute");
    s += server("du-old", OY, "Old server", [
      ["0", "running"],
      ["1", "stopping…", true],
      ["2 3 4", "gone"],
    ]);
    s += server("du-new", NY, "New server", [
      ["0 1", "starting…"],
      ["2 3", "running"],
      ["4", "✓ got the result", true],
    ]);
    s +=
      k.link(JX, JY + JH / 2 + 8, SW, NY + SH / 2, {
        dir: "h",
        in: "3 4",
        lit: true,
        send: true,
      }) + at("3 4", k.text(145, 150, "result", "k-ts k-ta"));
    // the job: its progress bar grows along the whole sequence (one timeline, restarted by each run)
    const keys = [0, 2100, 2200, 3400, 4000]
      .map((t) => +(t / 4000).toFixed(3))
      .join(";");
    const vals = [0.1, 0.55, 0.55, 0.8, 1]
      .map((v) => +(v * BW).toFixed(1))
      .join(";");
    s +=
      `<rect x="${JX}" y="${JY}" width="${JW}" height="${JH}" rx="${k.R.md}" class="k-box"/><rect x="${JX}" y="${JY}" width="${JW}" height="${JH}" rx="${k.R.md}" class="k-lit"/>` +
      k.text(JX + JW / 2, JY + 18, "Long job", "k-tb") +
      `<rect x="${JX + 12}" y="${JY + 28}" width="${BW}" height="6" rx="3" class="k-ink k-faint"/>` +
      `<g data-shot="bar"><rect x="${JX + 12}" y="${JY + 28}" width="${+(0.1 * BW).toFixed(1)}" height="6" rx="3" class="k-accf">` +
      `<animate attributeName="width" begin="indefinite" dur="4s" keyTimes="${keys}" values="${vals}" fill="freeze"/></rect></g>`;
    const ly = JY + JH + 15;
    s +=
      at("0", k.text(JX + JW / 2, ly, "running", "k-ts k-mute")) +
      at("1 2", k.text(JX + JW / 2, ly, "keeps running", "k-ts k-ta")) +
      at("3 4", k.text(JX + JW / 2, ly, "✓ done", "k-ts k-ta"));
    return k.svg(156, s);
  },
});
