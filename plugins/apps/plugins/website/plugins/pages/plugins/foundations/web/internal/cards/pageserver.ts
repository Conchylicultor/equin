import { defineCard } from "../kit/types";
import "./pageserver.css";

const TX = 0;
const TY = 4;
const TW = 150;
const TH = 170;
const AX = 12;
const AY = 24;
const AW = 126;
const AH = 50;
const CX = 176;
const CW = 126;
const SX = 27;
const SY = 92;
const SW = 96;
const SH = 30;
/** Where the cloud holds the server and data, from their place in the browser (pageserver.css slides them by it). */
const DX = 164;
const DY = -30;
/** The slide's length in s (pageserver.css): an arrow draws once the server has got where it reads from. */
const MOVE = 0.9;

/**
 * Server in the browser: the app's server and its data, first in the cloud, move into the browser, and the app
 * reads from them there. States: 0 in the cloud · 1 in the browser. Loops.
 */
export const pageserverCard = defineCard({
  states: 2,
  autoplay: { seq: [0, 1], every: [2600, 3400], lead: 1000 },
  render: (k) => {
    // the cloud, where the server starts
    let s =
      `<g class="ps-cloud">` +
      `<g transform="translate(${CX + 12} ${TY + 7}) scale(.5)" class="k-ic"><path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z"/></g>` +
      k.text(CX + 30, TY + 16, "Cloud", "k-ts k-mute", "start") +
      `</g>`;
    // the browser and the app in it: no words, just its shape
    s += k.text(TX + 12, TY + 14, "Browser", "k-ts k-mute", "start");
    // the app reads from wherever the server is, once it has got there; drawn under the app, so a
    // link's drawing (a background-coloured cover sliding off it) never cuts into the app's border
    s += k.link(AX + AW, AY + AH / 2, SX + DX, SY + DY + SH / 2, {
      dir: "h",
      in: "0",
      send: true,
      delay: MOVE,
    });
    s += k.link(AX + AW / 2, AY + AH, SX + SW / 2, SY, {
      dir: "v",
      in: "1",
      send: true,
      delay: MOVE,
    });
    s +=
      k.window(AX, AY, AW, AH, "") +
      [70, 92, 54]
        .map(
          (w, i) =>
            `<rect x="${AX + 10}" y="${AY + 25 + i * 8}" width="${w}" height="4" rx="2" class="k-box"/>`,
        )
        .join("");
    // the server and its data, moved as one
    s +=
      `<g class="ps-move"><g class="k-sw" data-on="1">` +
      k.box(SX, SY, SW, SH, { title: "Server" }) +
      k.link(SX + SW / 2, SY + SH, SX + SW / 2, SY + 44) +
      k.cylinder(SX + 12, SY + 50, SW - 24, "data", { h: 22 }) +
      `</g></g>`;
    // the two outlines go on top: the server and data cross them as they move, so neither border opens a gap
    s +=
      `<g class="ps-cloud"><rect x="${CX}" y="${TY}" width="${CW}" height="${TH}" rx="${k.R.lg}" class="k-ink k-faint" stroke-dasharray="4 3"/></g>` +
      `<rect x="${TX}" y="${TY}" width="${TW}" height="${TH}" rx="${k.R.lg}" class="k-ink"/>`;
    return k.svg(TY + TH + 4, s);
  },
});
