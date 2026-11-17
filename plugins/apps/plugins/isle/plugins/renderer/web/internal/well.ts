// The village well: a round stone shaft on a flagstone collar — its wall a
// true cylinder of staggered courses, lit from the left, its coping a ring of
// dressed stones round a dark mouth of water — under a shingled roof on two
// posts, with a windlass, its rope and a bucket. Drawn once, placed by its
// ground anchor (the front of its base). WELL_MOUTH is where the water is, for
// what the engine draws over it (the shimmer that gives the Undercroft away,
// the iris the hero falls through).

import {
  INK,
  inkLine,
  seeded,
  sprite,
  strHash,
  type Ctx,
  type Sprite,
} from "./kit";

/** The shaft's outer radius and its ellipse squash (px, before the sprite's 2×). */
const R = 25;
const SQ = 0.38;
/** The top of the wall (the coping's centre line) and the base's centre line. */
const Y_TOP = -24;
const Y_BASE = -5;

/** The water in the mouth, relative to the well's anchor. */
export const WELL_MOUTH = {
  dx: 0,
  dy: Y_TOP + 2,
  rx: R - 8,
  ry: (R - 8) * SQ,
} as const;

const mix = (a: readonly number[], b: readonly number[], k: number): string =>
  `rgb(${a.map((v, i) => Math.round(v + (b[i]! - v) * k)).join(",")})`;

const STONE_DARK = [112, 106, 94] as const;
const STONE_LIGHT = [196, 189, 172] as const;

/** The front of the wall between its top and base curves, as the current path. */
function wallPath(g: Ctx): void {
  const ry = R * SQ;
  g.beginPath();
  g.moveTo(-R, Y_TOP);
  g.lineTo(-R, Y_BASE);
  g.ellipse(0, Y_BASE, R, ry, 0, Math.PI, 0, true);
  g.lineTo(R, Y_TOP);
  g.ellipse(0, Y_TOP, R, ry, 0, 0, Math.PI, false);
  g.closePath();
}

export function wellSprite(): Sprite {
  const rnd = seeded(strHash("isle:well"));
  return sprite(104, 120, 52, 104, (g) => {
    const ry = R * SQ;
    // the cast shadow, off to the right (light from the upper left)
    g.fillStyle = "rgba(30,34,20,.28)";
    g.beginPath();
    g.ellipse(9, 1, 38, 13, 0, 0, 7);
    g.fill();

    // the flagstone collar the shaft stands on
    g.fillStyle = "#8f897b";
    g.beginPath();
    g.ellipse(0, Y_BASE + 1, R + 9, ry + 5, 0, 0, 7);
    g.fill();
    g.strokeStyle = INK;
    g.lineWidth = 0.9;
    g.stroke();
    g.save();
    g.beginPath();
    g.ellipse(0, Y_BASE + 1, R + 9, ry + 5, 0, 0, 7);
    g.clip();
    for (let i = 0; i < 9; i++) {
      const a = (i / 9) * Math.PI * 2 + 0.2;
      const c = Math.cos(a);
      const s = Math.sin(a);
      g.fillStyle = mix(STONE_DARK, STONE_LIGHT, 0.35 + rnd() * 0.3 - c * 0.15);
      g.beginPath();
      g.moveTo(c * (R - 2), Y_BASE + 1 + s * (ry - 1));
      const a2 = a + (Math.PI * 2) / 9 - 0.08;
      g.lineTo(Math.cos(a2) * (R - 2), Y_BASE + 1 + Math.sin(a2) * (ry - 1));
      g.lineTo(Math.cos(a2) * (R + 10), Y_BASE + 1 + Math.sin(a2) * (ry + 6));
      g.lineTo(c * (R + 10), Y_BASE + 1 + s * (ry + 6));
      g.closePath();
      g.fill();
    }
    g.restore();

    // the wall: courses of stones round the cylinder, each lit by where it faces
    wallPath(g);
    g.fillStyle = mix(STONE_DARK, STONE_LIGHT, 0.4);
    g.fill();
    g.save();
    wallPath(g);
    g.clip();
    const courses = 3;
    const h = (Y_BASE - Y_TOP) / courses;
    const per = 7;
    for (let c = 0; c <= courses; c++) {
      const y0 = Y_TOP + c * h;
      const off = (c % 2) * (Math.PI / per / 2);
      for (let k = -1; k < per + 1; k++) {
        const a0 = Math.max(0, k * (Math.PI / per) + off);
        const a1 = Math.min(Math.PI, (k + 1) * (Math.PI / per) + off);
        if (a1 <= a0) continue;
        const mid = (a0 + a1) / 2;
        // facing left (θ near π) is lit; facing right is in shade
        const lit = (1 - Math.cos(mid)) / 2;
        g.fillStyle = mix(
          STONE_DARK,
          STONE_LIGHT,
          Math.min(1, Math.max(0, lit * 0.85 + (rnd() - 0.5) * 0.18)),
        );
        g.beginPath();
        const n = 6;
        for (let i = 0; i <= n; i++) {
          const a = a0 + ((a1 - a0) * i) / n;
          const x = R * Math.cos(a);
          const y = y0 + ry * Math.sin(a) + 0.6;
          if (i) g.lineTo(x, y);
          else g.moveTo(x, y);
        }
        for (let i = n; i >= 0; i--) {
          const a = a0 + ((a1 - a0) * i) / n;
          g.lineTo(R * Math.cos(a) * 0.995, y0 + h + ry * Math.sin(a) - 0.6);
        }
        g.closePath();
        g.fill();
        g.strokeStyle = "rgba(52,48,42,.55)";
        g.lineWidth = 0.6;
        g.stroke();
      }
    }
    // moss creeping up from the ground on the shaded side, and up from the collar
    for (let i = 0; i < 6; i++) {
      const a = 0.25 + rnd() * 1.1;
      g.fillStyle = `rgba(${86 + rnd() * 20},${108 + rnd() * 20},58,.55)`;
      g.beginPath();
      g.ellipse(
        R * Math.cos(a),
        Y_BASE + ry * Math.sin(a) - 1 - rnd() * 3,
        3 + rnd() * 3,
        1.6 + rnd(),
        0,
        0,
        7,
      );
      g.fill();
    }
    // the shade under the coping's lip, and the ground's at the foot
    const lip = g.createLinearGradient(0, Y_TOP, 0, Y_TOP + 6);
    lip.addColorStop(0, "rgba(30,26,20,.45)");
    lip.addColorStop(1, "rgba(30,26,20,0)");
    g.fillStyle = lip;
    g.fillRect(-R, Y_TOP, R * 2, ry + 8);
    const side = g.createLinearGradient(-R, 0, R, 0);
    side.addColorStop(0, "rgba(255,248,230,.12)");
    side.addColorStop(0.45, "rgba(0,0,0,0)");
    side.addColorStop(1, "rgba(28,24,18,.3)");
    g.fillStyle = side;
    g.fillRect(-R, Y_TOP, R * 2, Y_BASE - Y_TOP + ry + 2);
    g.restore();
    wallPath(g);
    g.strokeStyle = INK;
    g.lineWidth = 1;
    g.stroke();

    // the coping: a ring of dressed stones round the mouth
    const oR = R + 2.5;
    const iR = R - 5.5;
    g.fillStyle = "#cbc5b6";
    g.beginPath();
    g.ellipse(0, Y_TOP, oR, oR * SQ, 0, 0, 7);
    g.fill();
    // the coping's front edge, a thickness in the light
    g.fillStyle = "#a9a395";
    g.beginPath();
    g.ellipse(0, Y_TOP, oR, oR * SQ, 0, 0, Math.PI);
    g.ellipse(0, Y_TOP + 2.5, oR, oR * SQ, 0, Math.PI, 0, true);
    g.closePath();
    g.fill();
    g.strokeStyle = INK;
    g.lineWidth = 1;
    g.beginPath();
    g.ellipse(0, Y_TOP + 2.5, oR, oR * SQ, 0, 0, Math.PI);
    g.stroke();
    g.beginPath();
    g.ellipse(0, Y_TOP, oR, oR * SQ, 0, Math.PI, 0);
    g.stroke();
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2 + 0.13;
      const c = Math.cos(a);
      const s = Math.sin(a);
      inkLine(
        g,
        [
          [c * iR, Y_TOP + s * iR * SQ],
          [c * oR, Y_TOP + s * oR * SQ + (s > 0 ? 2.5 : 0)],
        ],
        0.6,
        "rgba(70,64,56,.6)",
      );
    }
    // the mouth: the far inside wall going down, the water deep below it
    g.save();
    g.beginPath();
    g.ellipse(0, Y_TOP, iR, iR * SQ, 0, 0, 7);
    g.clip();
    const inner = g.createLinearGradient(
      0,
      Y_TOP - iR * SQ,
      0,
      Y_TOP + iR * SQ,
    );
    inner.addColorStop(0, "#5f5a50");
    inner.addColorStop(1, "#2a2823");
    g.fillStyle = inner;
    g.fillRect(-iR, Y_TOP - iR * SQ, iR * 2, iR * SQ * 2);
    const W = WELL_MOUTH;
    const water = g.createRadialGradient(-3, W.dy - 1, 1, 0, W.dy, W.rx);
    water.addColorStop(0, "#2d4a55");
    water.addColorStop(1, "#101c22");
    g.fillStyle = water;
    g.beginPath();
    g.ellipse(W.dx, W.dy + 1.5, W.rx, W.ry, 0, 0, 7);
    g.fill();
    g.strokeStyle = "rgba(200,225,230,.25)";
    g.lineWidth = 0.7;
    g.beginPath();
    g.ellipse(
      W.dx - 3,
      W.dy + 0.5,
      W.rx * 0.45,
      W.ry * 0.35,
      0,
      Math.PI * 1.1,
      Math.PI * 1.7,
    );
    g.stroke();
    g.restore();
    g.strokeStyle = INK;
    g.lineWidth = 0.8;
    g.beginPath();
    g.ellipse(0, Y_TOP, iR, iR * SQ, 0, 0, 7);
    g.stroke();

    // the posts, standing on the coping either side
    const postTop = -72;
    for (const x of [-R + 0.5, R - 4.5]) {
      g.fillStyle = "#6a5338";
      g.fillRect(x, postTop, 4, Y_TOP - postTop + 1);
      g.fillStyle = "#86704f";
      g.fillRect(x, postTop, 1.5, Y_TOP - postTop + 1);
      g.strokeStyle = INK;
      g.lineWidth = 0.9;
      g.strokeRect(x, postTop, 4, Y_TOP - postTop + 1);
    }
    // the windlass: a log between the posts, the rope wound on it, a crank on the right
    const wy = -55;
    g.fillStyle = "#7b6549";
    g.fillRect(-R + 4.5, wy - 3, (R - 4.5) * 2, 6);
    g.fillStyle = "#97805e";
    g.fillRect(-R + 4.5, wy - 3, (R - 4.5) * 2, 2);
    g.strokeStyle = INK;
    g.lineWidth = 0.8;
    g.strokeRect(-R + 4.5, wy - 3, (R - 4.5) * 2, 6);
    for (let x = -7; x <= 7; x += 2)
      inkLine(
        g,
        [
          [x, wy - 3],
          [x + 1.6, wy + 3],
        ],
        0.9,
        "#b49a6c",
      );
    inkLine(
      g,
      [
        [R, wy],
        [R + 5, wy],
        [R + 5, wy + 7],
        [R + 8, wy + 7],
      ],
      1.4,
      "#4a3b2a",
    );
    // the rope down to the bucket, hanging over the mouth
    inkLine(
      g,
      [
        [0, wy + 3],
        [0.4, -40],
      ],
      0.9,
      "#5a4730",
    );
    const by = -40;
    g.fillStyle = "#7d6546";
    g.beginPath();
    g.moveTo(-5.5, by);
    g.lineTo(5.5, by);
    g.lineTo(4.5, by + 9);
    g.lineTo(-4.5, by + 9);
    g.closePath();
    g.fill();
    g.fillStyle = "#5e4a34";
    g.fillRect(1.5, by, 3.5, 9);
    g.strokeStyle = INK;
    g.lineWidth = 0.8;
    g.beginPath();
    g.moveTo(-5.5, by);
    g.lineTo(5.5, by);
    g.lineTo(4.5, by + 9);
    g.lineTo(-4.5, by + 9);
    g.closePath();
    g.stroke();
    for (const y of [by + 2, by + 7])
      inkLine(
        g,
        [
          [-5.4 + (y - by) * 0.11, y],
          [5.4 - (y - by) * 0.11, y],
        ],
        1,
        "#4b4a48",
      );
    g.strokeStyle = "#4b4a48";
    g.lineWidth = 0.7;
    g.beginPath();
    g.arc(0, by + 1, 5.5, Math.PI * 1.05, Math.PI * 1.95);
    g.stroke();

    // the roof: a shingled slope on a ridge beam, its eave board in shadow
    const ridge = -96;
    const eave = -70;
    const slope: [number, number][] = [
      [-27, ridge],
      [27, ridge],
      [39, eave],
      [-39, eave],
    ];
    g.fillStyle = "#3b2c20";
    g.fillRect(-37, eave, 74, 3.5);
    g.beginPath();
    slope.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)));
    g.closePath();
    g.fillStyle = "#7d4f36";
    g.fill();
    g.save();
    g.clip();
    const rows = 4;
    const rh = (eave - ridge) / rows;
    for (let r = 0; r < rows; r++) {
      const y = ridge + r * rh;
      const half = 27 + ((39 - 27) * (r + 1)) / rows;
      const tw = 7;
      for (let x = -half - (r % 2 ? tw / 2 : 0); x < half; x += tw) {
        const lit = 0.5 - (x / half) * 0.25 + (rnd() - 0.5) * 0.2;
        g.fillStyle = mix([92, 56, 38], [168, 110, 72], lit);
        g.beginPath();
        g.moveTo(x, y);
        g.lineTo(x + tw, y);
        g.lineTo(x + tw, y + rh - 2);
        g.quadraticCurveTo(x + tw / 2, y + rh + 1.5, x, y + rh - 2);
        g.closePath();
        g.fill();
        g.strokeStyle = "rgba(48,30,20,.6)";
        g.lineWidth = 0.6;
        g.stroke();
      }
    }
    const shade = g.createLinearGradient(-39, 0, 39, 0);
    shade.addColorStop(0, "rgba(255,240,210,.1)");
    shade.addColorStop(1, "rgba(30,18,10,.25)");
    g.fillStyle = shade;
    g.fillRect(-40, ridge, 80, eave - ridge);
    g.restore();
    g.beginPath();
    slope.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)));
    g.closePath();
    g.strokeStyle = INK;
    g.lineWidth = 1.1;
    g.stroke();
    // the ridge beam, a little proud of the slope at either end
    g.fillStyle = "#5e4a34";
    g.fillRect(-30, ridge - 3, 60, 4);
    g.strokeRect(-30, ridge - 3, 60, 4);
  });
}
