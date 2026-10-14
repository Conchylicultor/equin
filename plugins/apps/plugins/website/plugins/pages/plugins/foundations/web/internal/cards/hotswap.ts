import { defineCard } from "../kit/types";
import "./hotswap.css";

const TW = 100;
const TY = 48;
const TH = 58;
const GX = 116;
const GW = 56;
const GY = 56;
const GH = 42;
const SX = 208;
const SW = 94;
const SH = 40;
const OY = 8;
const NY = 104;
const gm = GY + GH / 2;

/**
 * Zero-downtime restart: your tab stays connected while the gateway moves its requests from the old server to the
 * new one, deploying again and again on a loop.
 */
export const hotswapCard = defineCard({
  states: 4, // 0 old serving · 1 new starting beside it · 2 new ready, requests switch, old stopping · 3 old gone
  autoplay: { seq: [0, 1, 2, 3], every: [1800, 1600, 1300, 2000], lead: 1000 },
  render: (k) => {
    const at = (states: string, body: string) =>
      `<g data-in="${states}">${body}</g>`;
    // a server: its lane (lit while it carries the traffic), box and name for good, then one status word per set of states
    const server = (
      cls: string,
      y: number,
      title: string,
      serving: string,
      statuses: readonly (readonly [string, string, boolean?])[],
    ) =>
      `<g class="hs-srv ${cls}">${k.link(GX + GW, gm, SX, y + SH / 2, { dir: "h", on: serving })}` +
      `<rect x="${SX}" y="${y}" width="${SW}" height="${SH}" rx="${k.R.md}" class="k-box hs-frame"/>` +
      `<rect x="${SX}" y="${y}" width="${SW}" height="${SH}" rx="${k.R.md}" class="k-lit hs-lit"/>` +
      k.text(SX + SW / 2, y + SH / 2 - 2, title, "k-tb") +
      statuses
        .map(([st, t, lit]) =>
          at(
            st,
            k.text(
              SX + SW / 2,
              y + SH / 2 + 11,
              t,
              lit ? "k-ts k-ta" : "k-ts k-mute",
            ),
          ),
        )
        .join("") +
      `</g>`;
    const stream = (y: number) =>
      [0, 1, 2]
        .map((i) =>
          k.dot(k.curve(GX + GW, gm, SX, y + SH / 2, "h").d, {
            dur: 1.2,
            delay: i * 0.4,
          }),
        )
        .join("");
    const wire = k.curve(TW, gm, GX, gm, "h").d;
    const back = `M${GX} ${gm} H${TW}`;
    let s =
      k.text(TW / 2, TY - 8, "Your tab", "k-tb") +
      k.window(
        0,
        TY,
        TW,
        TH,
        "mail.localhost",
        k.text(TW / 2, TY + 42, "✓ connected", "k-ts k-ta"),
      );
    s +=
      k.link(TW, gm, GX, gm, { dir: "h", lit: true }) +
      k.dot(wire, { dur: 1.2 }) +
      k.dot(back, { dur: 1.2, delay: 0.6 });
    s += k.box(GX, GY, GW, GH, { title: "Gateway" });
    s +=
      server("hs-old", OY, "Old server", "0 1", [
        ["0 1", "serving", true],
        ["2", "stopping…"],
        ["3", "stopped"],
      ]) + at("0 1", stream(OY));
    s +=
      server("hs-new", NY, "New server", "2 3", [
        ["0 1", "starting…"],
        ["2 3", "serving", true],
      ]) + at("2 3", stream(NY));
    return k.svg(150, s);
  },
});
