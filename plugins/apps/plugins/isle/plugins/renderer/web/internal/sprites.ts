// The scenery sprites: faceted boulders, clumped broadleaf trees and pines,
// bushes, props (barrels, crates, a well, lamps…), clouds, the dock, the boat
// and the ferry — each drawn once and placed many times. Made in the
// prototype's order from one seeded stream, so the island looks the same.

import {
  INK,
  blob,
  blobPath,
  inkLine,
  seeded,
  sprite,
  strHash,
  type Ctx,
  type Rnd,
  type Sprite,
} from "./kit";
import { ROCK_COUNT, rockSize } from "./kit";

type Palette = readonly [string, string, string, string, string];

export const TREE_PAL: Readonly<
  Record<"green" | "olive" | "deep" | "autumn", Palette>
> = {
  green: ["#2f3b22", "#45542f", "#5c6b3b", "#7a8850", "#9da46c"],
  olive: ["#39411f", "#515b2c", "#6b7338", "#8a9050", "#aaa86c"],
  deep: ["#28341f", "#3b4a2c", "#52613a", "#6c7a4c", "#8a9668"],
  autumn: ["#4f3d20", "#6e5428", "#8e6d36", "#ab8a4b", "#c4a76c"],
};

const poly = (g: Ctx, pts: readonly (readonly [number, number])[]) => {
  g.beginPath();
  pts.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)));
  g.closePath();
};

function boulderSprite(rnd: Rnd, s: number, mossy: boolean): Sprite {
  return sprite(s * 2.6, s * 2.2, s * 1.3, s * 1.45, (g) => {
    const n = 7 + ((rnd() * 3) | 0);
    const pts: [number, number][] = [];
    for (let i = 0; i < n; i++) {
      const a = Math.PI + (i / (n - 1)) * Math.PI;
      const r = s * (0.78 + rnd() * 0.32);
      pts.push([Math.cos(a) * r, Math.sin(a) * r * (0.9 + rnd() * 0.3)]);
    }
    const base: [number, number][] = [
      [s * 1.02, s * 0.12],
      [s * 0.5, s * 0.36],
      [-s * 0.4, s * 0.38],
      [-s * 1.0, s * 0.14],
    ];
    const outline = [...pts, ...base];
    g.fillStyle = "rgba(30,40,45,.28)";
    g.beginPath();
    g.ellipse(s * 0.25, s * 0.36, s * 1.15, s * 0.42, 0, 0, 7);
    g.fill();
    poly(g, outline);
    g.fillStyle = "#777c83";
    g.fill();
    g.save();
    g.clip();
    g.fillStyle = "#4e535a";
    poly(g, [
      [s * 0.15, -s * 0.2],
      [s * 1.2, -s * 0.1],
      [s * 1.2, s * 0.6],
      [-s * 0.2, s * 0.6],
      [-s * 0.1, s * 0.1],
    ]);
    g.fill();
    g.fillStyle = "#a9adb1";
    poly(g, [
      [-s * 1.2, -s * 0.1],
      [-s * 0.6, -s * 1.1],
      [s * 0.35, -s * 1.1],
      [s * 0.1, -s * 0.3],
      [-s * 0.5, -s * 0.05],
    ]);
    g.fill();
    g.fillStyle = "#c3c6c8";
    poly(g, [
      [-s * 0.7, -s * 0.55],
      [-s * 0.35, -s * 0.95],
      [s * 0.1, -s * 0.85],
      [-s * 0.15, -s * 0.45],
    ]);
    g.fill();
    for (let i = 0; i < s * 3; i++) {
      g.fillStyle =
        rnd() < 0.5 ? "rgba(40,45,52,.22)" : "rgba(230,232,232,.25)";
      g.fillRect((rnd() - 0.5) * s * 2, -s * rnd() * 1.1 + s * 0.2, 1.2, 1.2);
    }
    if (mossy)
      for (let i = 0; i < s * 1.5; i++) {
        g.fillStyle = ["#6f7a42", "#8b9455", "#5c6838"][(rnd() * 3) | 0]!;
        g.beginPath();
        g.arc(
          (rnd() - 0.6) * s * 1.4,
          -s * (0.55 + rnd() * 0.45),
          1 + rnd() * 2.2,
          0,
          7,
        );
        g.fill();
      }
    g.restore();
    inkLine(
      g,
      [
        [-s * 0.5, -s * 0.05],
        [s * 0.1, -s * 0.3],
        [s * 0.35, -s * 1.0],
      ],
      0.9,
      "rgba(40,40,45,.55)",
    );
    inkLine(
      g,
      [
        [s * 0.1, -s * 0.3],
        [s * 0.15, s * 0.3],
      ],
      0.9,
      "rgba(40,40,45,.5)",
    );
    if (s > 18)
      inkLine(
        g,
        [
          [-s * 0.8, -s * 0.2],
          [-s * 0.55, -s * 0.35],
          [-s * 0.6, -s * 0.6],
        ],
        0.8,
        "rgba(40,40,45,.45)",
      );
    poly(g, outline);
    g.strokeStyle = "rgba(36,34,36,.85)";
    g.lineWidth = 1.3;
    g.stroke();
  });
}

interface Clump {
  x: number;
  y: number;
  r: number;
  rn?: Rnd;
  p?: Path2D;
}

function broadleaf(rnd: Rnd, pal: Palette, size: number): Sprite {
  const R = size;
  return sprite(R * 3.2, R * 3.6, R * 1.6, R * 3.35, (g) => {
    g.fillStyle = "rgba(40,48,25,.30)";
    g.beginPath();
    g.ellipse(R * 0.35, -R * 0.05, R * 1.25, R * 0.42, 0, 0, 7);
    g.fill();
    // the crown's own seed (br) keeps the shared stream — and every sprite made after a tree — unchanged
    const br = seeded(strHash(pal[0]) ^ Math.round(size * 7919));
    const top = -R * 1.5;
    const bark = "#4e3f2c";
    const dark = "#33291e";
    g.fillStyle = bark;
    g.beginPath();
    g.moveTo(-R * 0.17, 0);
    g.quadraticCurveTo(-R * 0.1, -R * 0.4, -R * 0.08, top);
    g.lineTo(R * 0.08, top);
    g.quadraticCurveTo(R * 0.1, -R * 0.4, R * 0.19, 0);
    g.closePath();
    g.fill();
    g.fillStyle = dark;
    g.beginPath();
    g.moveTo(R * 0.04, 0);
    g.lineTo(R * 0.02, top);
    g.lineTo(R * 0.08, top);
    g.quadraticCurveTo(R * 0.1, -R * 0.4, R * 0.19, 0);
    g.closePath();
    g.fill();
    const lean = (br() - 0.5) * 0.2;
    for (const [side, y0, w] of [
      [-1, -0.82, 0.1],
      [1, -0.95, 0.085],
    ] as const) {
      const ex = side * R * (0.38 + br() * 0.12) + lean * R;
      const ey = -R * (1.45 + br() * 0.15);
      g.strokeStyle = bark;
      g.lineCap = "round";
      g.lineWidth = w * R;
      g.beginPath();
      g.moveTo(side * R * 0.02, R * y0);
      g.quadraticCurveTo(side * R * 0.08, R * (y0 - 0.35), ex, ey);
      g.stroke();
      g.strokeStyle = "rgba(28,24,18,.75)";
      g.lineWidth = 1;
      g.beginPath();
      g.moveTo(side * R * 0.02 + side * w * R * 0.5, R * y0);
      g.quadraticCurveTo(
        side * R * 0.08 + side * w * R * 0.5,
        R * (y0 - 0.35),
        ex + side * 1.5,
        ey,
      );
      g.stroke();
    }
    inkLine(
      g,
      [
        [-R * 0.17, 0],
        [-R * 0.1, -R * 0.4],
        [-R * 0.08, top],
      ],
      1,
    );
    inkLine(
      g,
      [
        [R * 0.19, 0],
        [R * 0.1, -R * 0.4],
        [R * 0.08, top],
      ],
      1,
    );
    const sh = g.createLinearGradient(0, -R * 0.62, 0, -R * 0.95);
    sh.addColorStop(0, "rgba(22,26,14,0)");
    sh.addColorStop(1, "rgba(22,26,14,.6)");
    g.globalCompositeOperation = "source-atop";
    g.fillStyle = sh;
    g.fillRect(-R * 0.3, -R * 0.95, R * 0.6, R * 0.33);
    g.globalCompositeOperation = "source-over";
    const clumps: Clump[] = [];
    const n = 9 + ((rnd() * 5) | 0);
    for (let i = 0; i < n; i++) {
      const a = rnd() * Math.PI * 2;
      const d = rnd() * R * 0.75;
      clumps.push({
        x: Math.cos(a) * d,
        y: -R * 1.6 + Math.sin(a) * d * 0.7,
        r: R * (0.4 + rnd() * 0.24),
      });
    }
    for (const [x, y, r] of [
      [-0.42, -1.3, 0.4],
      [0.4, -1.32, 0.4],
      [0.02, -1.2, 0.4],
    ] as const)
      clumps.push({
        x: R * (x + (br() - 0.5) * 0.1),
        y: R * (y + (br() - 0.5) * 0.06),
        r: R * (r + br() * 0.05),
        rn: br,
      });
    clumps.sort((a, b) => a.y - b.y);
    for (const c of clumps) {
      c.rn = c.rn ?? rnd;
      c.p = blobPath(c.x, c.y, c.r, c.rn, 11, 0.26);
    }
    g.strokeStyle = "rgba(28,34,20,.92)";
    g.lineWidth = 2.4;
    g.lineJoin = "round";
    for (const c of clumps) g.stroke(c.p!);
    g.fillStyle = pal[0];
    for (const c of clumps) g.fill(c.p!);
    for (const c of clumps) {
      const r2 = c.rn!;
      g.fillStyle = pal[1];
      blob(g, c.x - c.r * 0.12, c.y - c.r * 0.12, c.r * 0.82, r2, 9, 0.35);
      g.fill();
      g.fillStyle = pal[2];
      blob(g, c.x - c.r * 0.25, c.y - c.r * 0.28, c.r * 0.55, r2, 8, 0.4);
      g.fill();
      for (let k = 0; k < 11; k++) {
        const a = r2() * Math.PI * 2;
        const d = r2() * c.r * 0.7;
        const x = c.x + Math.cos(a) * d - c.r * 0.25;
        const y = c.y + Math.sin(a) * d * 0.8 - c.r * 0.25;
        g.fillStyle = r2() < 0.75 ? pal[3] : pal[4];
        g.beginPath();
        g.ellipse(x, y, 1.6 + r2() * 1.6, 1.1 + r2(), r2() * 3, 0, 7);
        g.fill();
      }
      g.strokeStyle = "rgba(25,30,18,.45)";
      g.lineWidth = 1;
      g.beginPath();
      g.arc(c.x + c.r * 0.1, c.y + c.r * 0.1, c.r * 0.82, 0.2, 2.2);
      g.stroke();
    }
    for (let k = 0; k < 10; k++) {
      g.fillStyle = "rgba(25,32,18,.5)";
      g.beginPath();
      g.arc(
        (rnd() - 0.5) * R * 1.3,
        -R * 1.85 + (rnd() - 0.3) * R,
        1 + rnd() * 2,
        0,
        7,
      );
      g.fill();
    }
  });
}

function pine(rnd: Rnd, pal: Palette, size: number): Sprite {
  const R = size;
  return sprite(R * 2.4, R * 4.2, R * 1.2, R * 4.0, (g) => {
    g.fillStyle = "rgba(40,48,25,.30)";
    g.beginPath();
    g.ellipse(R * 0.3, -R * 0.05, R * 0.9, R * 0.32, 0, 0, 7);
    g.fill();
    g.fillStyle = "#4e3e2c";
    g.fillRect(-R * 0.08, -R * 0.8, R * 0.16, R * 0.8);
    for (let i = 0; i < 5; i++) {
      const y = -R * 0.55 - i * R * 0.62;
      const w = R * (1.0 - i * 0.17);
      const top = y - R * 0.95;
      const pts: [number, number][] = [[-w, y]];
      const teeth = 7;
      for (let k = 1; k < teeth; k++) {
        const x = -w + (2 * w * k) / teeth;
        pts.push([x, y + (k % 2 ? R * 0.12 : -R * 0.02) + rnd() * 3]);
      }
      pts.push([w, y], [0, top]);
      poly(g, pts);
      g.fillStyle = pal[0];
      g.fill();
      g.strokeStyle = "rgba(25,32,20,.9)";
      g.lineWidth = 1.4;
      g.stroke();
      g.fillStyle = pal[1];
      g.beginPath();
      g.moveTo(-w * 0.85, y - 2);
      g.lineTo(0, top + 4);
      g.lineTo(w * 0.1, y - 4);
      g.closePath();
      g.fill();
      for (let k = 0; k < 12; k++) {
        const x = (rnd() - 0.7) * w;
        const yy = y - rnd() * R * 0.7;
        g.strokeStyle = rnd() < 0.5 ? pal[3] : pal[2];
        g.lineWidth = 1;
        g.beginPath();
        g.moveTo(x, yy);
        g.lineTo(x + 3, yy + 2);
        g.stroke();
      }
    }
  });
}

function bushSprite(rnd: Rnd, pal: Palette): Sprite {
  return sprite(70, 50, 35, 42, (g) => {
    g.fillStyle = "rgba(40,48,25,.28)";
    g.beginPath();
    g.ellipse(6, 0, 24, 8, 0, 0, 7);
    g.fill();
    const cl = [
      [-10, -10, 11],
      [8, -11, 12],
      [0, -19, 11],
      [-2, -6, 10],
    ] as const;
    const ps = cl.map(([x, y, r]) => blobPath(x, y, r, rnd, 9, 0.28));
    g.strokeStyle = "rgba(28,34,20,.88)";
    g.lineWidth = 1.8;
    g.lineJoin = "round";
    ps.forEach((P) => g.stroke(P));
    g.fillStyle = pal[0];
    ps.forEach((P) => g.fill(P));
    for (const [x, y, r] of cl) {
      g.fillStyle = pal[1];
      blob(g, x - 2, y - 2, r * 0.75, rnd, 8, 0.35);
      g.fill();
      g.fillStyle = pal[2];
      blob(g, x - 4, y - 4, r * 0.4, rnd, 7, 0.4);
      g.fill();
    }
    for (let k = 0; k < 18; k++) {
      g.fillStyle = rnd() < 0.5 ? pal[3] : pal[4];
      g.beginPath();
      g.ellipse(-14 + rnd() * 26, -26 + rnd() * 20, 1.4, 1, rnd() * 3, 0, 7);
      g.fill();
    }
  });
}

const shadowEllipse = (g: Ctx, x: number, rx: number, ry: number) => {
  g.fillStyle = "rgba(30,34,20,.3)";
  g.beginPath();
  g.ellipse(x, 0, rx, ry, 0, 0, 7);
  g.fill();
};

function lampSprite(night: boolean): Sprite {
  return sprite(24, 70, 12, 66, (g) => {
    shadowEllipse(g, 4, 7, 2.5);
    g.fillStyle = "#3b3a37";
    g.fillRect(-1.6, -46, 3.2, 46);
    g.fillRect(-5, -3, 10, 3);
    g.fillStyle = night ? "#ffd987" : "#d9d2bd";
    poly(g, [
      [-5.5, -46],
      [5.5, -46],
      [4, -57],
      [-4, -57],
    ]);
    g.fill();
    g.strokeStyle = "#252421";
    g.lineWidth = 1.4;
    g.stroke();
    g.fillStyle = "#2a2926";
    poly(g, [
      [-6.5, -57],
      [0, -62],
      [6.5, -57],
    ]);
    g.fill();
  });
}

export interface Props {
  readonly barrel: Sprite;
  readonly crates: Sprite;
  readonly sacks: Sprite;
  readonly well: Sprite;
  readonly haystack: Sprite;
  readonly stump: Sprite;
  /** By time of day: lit at night. */
  readonly lamp: { readonly day: Sprite; readonly night: Sprite };
  readonly bushes: readonly Sprite[];
}

function makeProps(rnd: Rnd): Props {
  const barrel = sprite(34, 40, 17, 36, (g) => {
    shadowEllipse(g, 4, 12, 4);
    g.fillStyle = "#7d6546";
    g.beginPath();
    g.moveTo(-9, 0);
    g.quadraticCurveTo(-12, -13, -9, -26);
    g.lineTo(9, -26);
    g.quadraticCurveTo(12, -13, 9, 0);
    g.closePath();
    g.fill();
    g.strokeStyle = INK;
    g.lineWidth = 1;
    g.stroke();
    g.fillStyle = "#5e4a34";
    g.fillRect(2, -25, 7, 24);
    for (let i = -6; i < 9; i += 4)
      inkLine(
        g,
        [
          [i, -25],
          [i + (i > 0 ? 1 : -1), -1],
        ],
        0.6,
        "rgba(50,40,28,.5)",
      );
    g.fillStyle = "#9b8562";
    g.beginPath();
    g.ellipse(0, -26, 9, 3.2, 0, 0, 7);
    g.fill();
    g.stroke();
    for (const y of [-20, -7])
      inkLine(
        g,
        [
          [-10.5, y],
          [10.5, y],
        ],
        1.8,
        "#4b4a48",
      );
  });
  const crates = sprite(56, 50, 26, 44, (g) => {
    shadowEllipse(g, 6, 22, 6);
    const box = (x: number, y: number, s: number) => {
      g.fillStyle = "#a08662";
      g.fillRect(x, y, s, s);
      g.fillStyle = "#86704f";
      g.fillRect(x + s * 0.65, y, s * 0.35, s);
      g.fillStyle = "#b9a07a";
      g.fillRect(x, y - s * 0.28, s, s * 0.28);
      g.strokeStyle = INK;
      g.lineWidth = 1;
      g.strokeRect(x, y - s * 0.28, s, s * 1.28);
      inkLine(
        g,
        [
          [x, y],
          [x + s, y],
        ],
        0.9,
      );
      inkLine(
        g,
        [
          [x + 2, y + 2],
          [x + s - 2, y + s - 2],
        ],
        0.8,
        "rgba(60,46,30,.6)",
      );
    };
    box(-20, -18, 18);
    box(0, -16, 16);
    box(-12, -40, 16);
  });
  const sacks = sprite(44, 34, 20, 30, (g) => {
    shadowEllipse(g, 5, 18, 5);
    for (const [x, y, r] of [
      [-8, -2, 9],
      [7, -1, 8],
      [0, -10, 8],
    ] as const) {
      g.fillStyle = "#b4a07a";
      blob(g, x, y - r * 0.6, r, rnd, 8, 0.2);
      g.fill();
      g.strokeStyle = INK;
      g.lineWidth = 0.9;
      g.stroke();
      g.fillStyle = "rgba(90,70,45,.35)";
      g.beginPath();
      g.ellipse(x + r * 0.3, y - r * 0.4, r * 0.5, r * 0.6, 0, 0, 7);
      g.fill();
    }
  });
  const well = sprite(80, 90, 40, 80, (g) => {
    shadowEllipse(g, 6, 32, 10);
    g.fillStyle = "#9b968a";
    g.beginPath();
    g.ellipse(0, -14, 26, 11, 0, 0, Math.PI);
    g.lineTo(-26, -14);
    g.closePath();
    g.fillRect(-26, -14, 52, 14);
    g.beginPath();
    g.ellipse(0, 0, 26, 9, 0, 0, Math.PI);
    g.fill();
    for (let r = 0; r < 2; r++)
      for (let i = 0; i < 7; i++) {
        const x = -26 + i * 7.5 + (r ? 3.5 : 0);
        g.fillStyle = rnd() < 0.5 ? "#aaa598" : "#8e897d";
        g.fillRect(x, -13 + r * 6.5, 7, 6);
        g.strokeStyle = "rgba(50,48,44,.6)";
        g.lineWidth = 0.7;
        g.strokeRect(x, -13 + r * 6.5, 7, 6);
      }
    g.fillStyle = "#b5b0a3";
    g.beginPath();
    g.ellipse(0, -14, 26, 10, 0, 0, 7);
    g.fill();
    g.strokeStyle = INK;
    g.lineWidth = 1;
    g.stroke();
    g.fillStyle = "#24343e";
    g.beginPath();
    g.ellipse(0, -14, 19, 7, 0, 0, 7);
    g.fill();
    g.fillStyle = "#5e4a34";
    g.fillRect(-23, -60, 4, 46);
    g.fillRect(19, -60, 4, 46);
    g.strokeStyle = INK;
    g.strokeRect(-23, -60, 4, 46);
    g.strokeRect(19, -60, 4, 46);
    g.fillStyle = "#7b6549";
    poly(g, [
      [-32, -56],
      [0, -76],
      [32, -56],
      [28, -52],
      [0, -70],
      [-28, -52],
    ]);
    g.fill();
    g.stroke();
    for (let i = 0; i < 8; i++)
      inkLine(
        g,
        [
          [-28 + i * 7, -54],
          [-26 + i * 7 + (i < 4 ? 3 : -3), -66 + Math.abs(i - 4) * 2.5],
        ],
        0.6,
        "rgba(50,40,28,.55)",
      );
    inkLine(
      g,
      [
        [-20, -48],
        [20, -48],
      ],
      2,
      "#6d5638",
    );
    inkLine(
      g,
      [
        [0, -48],
        [0, -30],
      ],
      0.8,
      "#4a3b2a",
    );
    g.fillStyle = "#6d5638";
    g.fillRect(-4, -31, 8, 7);
    g.strokeRect(-4, -31, 8, 7);
  });
  const haystack = sprite(70, 60, 34, 54, (g) => {
    shadowEllipse(g, 8, 30, 8);
    g.fillStyle = "#bba566";
    g.beginPath();
    g.moveTo(-28, 0);
    g.quadraticCurveTo(-30, -40, 0, -46);
    g.quadraticCurveTo(30, -40, 28, 0);
    g.closePath();
    g.fill();
    g.strokeStyle = INK;
    g.lineWidth = 1;
    g.stroke();
    g.fillStyle = "rgba(120,100,50,.35)";
    g.beginPath();
    g.moveTo(4, -44);
    g.quadraticCurveTo(30, -38, 28, 0);
    g.lineTo(6, 0);
    g.closePath();
    g.fill();
    for (let i = 0; i < 40; i++) {
      const x = -24 + rnd() * 48;
      const y = -4 - rnd() * 36;
      if (Math.abs(x) > 28 - -y * 0.2) continue;
      inkLine(
        g,
        [
          [x, y],
          [x + 1 + rnd() * 2, y - 5 - rnd() * 4],
        ],
        0.7,
        rnd() < 0.5 ? "rgba(110,90,45,.6)" : "rgba(230,215,160,.6)",
      );
    }
  });
  const stump = sprite(34, 26, 16, 20, (g) => {
    shadowEllipse(g, 4, 13, 4);
    g.fillStyle = "#6a553c";
    poly(g, [
      [-11, 0],
      [-9, -11],
      [9, -11],
      [11, 0],
    ]);
    g.fill();
    g.strokeStyle = INK;
    g.lineWidth = 1;
    g.stroke();
    g.fillStyle = "#c2a97c";
    g.beginPath();
    g.ellipse(0, -11, 9, 3.6, 0, 0, 7);
    g.fill();
    g.stroke();
    g.strokeStyle = "rgba(110,86,56,.7)";
    g.lineWidth = 0.6;
    g.beginPath();
    g.ellipse(0, -11, 4.5, 1.7, 0, 0, 7);
    g.stroke();
  });
  // (the lamp draws no random numbers, so both of its looks leave the stream as it was)
  const lamp = { day: lampSprite(false), night: lampSprite(true) };
  const bushes = [
    TREE_PAL.green,
    TREE_PAL.olive,
    TREE_PAL.deep,
    TREE_PAL.green,
  ].map((p) => bushSprite(rnd, p));
  return { barrel, crates, sacks, well, haystack, stump, lamp, bushes };
}

function cloudSprite(rnd: Rnd): Sprite {
  return sprite(320, 150, 160, 120, (g) => {
    for (let i = 0; i < 26; i++) {
      const x = (rnd() - 0.5) * 230;
      const y = -40 + (rnd() - 0.5) * 50 - Math.abs(x) * 0.12;
      const r = 22 + rnd() * 30;
      const gr = g.createRadialGradient(x, y, 0, x, y, r);
      gr.addColorStop(0, "rgba(255,255,255,.34)");
      gr.addColorStop(0.7, "rgba(250,252,255,.16)");
      gr.addColorStop(1, "rgba(250,252,255,0)");
      g.fillStyle = gr;
      g.beginPath();
      g.arc(x, y, r, 0, 7);
      g.fill();
    }
    for (let i = 0; i < 10; i++) {
      const x = (rnd() - 0.5) * 200;
      const y = -22 + rnd() * 10;
      const r = 18 + rnd() * 20;
      const gr = g.createRadialGradient(x, y, 0, x, y, r);
      gr.addColorStop(0, "rgba(150,170,200,.12)");
      gr.addColorStop(1, "rgba(150,170,200,0)");
      g.fillStyle = gr;
      g.beginPath();
      g.arc(x, y, r, 0, 7);
      g.fill();
    }
  });
}

export const DOCK_LEN = 190;

export interface Rock {
  readonly s: number;
  readonly sp: Sprite;
}

/** Every sprite the scene stamps, and the stream they leave behind for the scene's own draws. */
export interface SpriteSet {
  readonly rocks: readonly Rock[];
  /** Broadleaf and pines: 0..7 broadleaf, 8..10 pines. */
  readonly trees: readonly Sprite[];
  readonly autumn: readonly Sprite[];
  readonly props: Props;
  readonly clouds: readonly Sprite[];
  readonly dock: Sprite;
  readonly boat: Sprite;
  readonly ferry: Sprite;
  readonly campStones: Sprite;
  /** The scene's stream, past the sprites (ripples, clouds, gulls, villagers draw from it). */
  readonly rnd: Rnd;
}

export function makeSprites(): SpriteSet {
  const rnd = seeded(20251111);
  const rocks = Array.from({ length: ROCK_COUNT }, (_, i) => {
    const s = rockSize(i);
    return { s, sp: boulderSprite(rnd, s, i % 3 === 0) };
  });
  const trees: Sprite[] = [];
  for (let i = 0; i < 4; i++)
    trees.push(
      broadleaf(rnd, TREE_PAL.green, 31 + i * 4),
      broadleaf(rnd, TREE_PAL.olive, 29 + i * 4),
    );
  for (let i = 0; i < 3; i++) trees.push(pine(rnd, TREE_PAL.deep, 26 + i * 4));
  const autumn = [
    broadleaf(rnd, TREE_PAL.autumn, 32),
    broadleaf(rnd, TREE_PAL.autumn, 36),
  ];
  const props = makeProps(rnd);
  const clouds = [cloudSprite(rnd), cloudSprite(rnd), cloudSprite(rnd)];
  const dock = sprite(DOCK_LEN + 20, 70, 10, 35, (dg) => {
    for (let i = 0; i < DOCK_LEN; i += 11) {
      const t = rnd();
      dg.fillStyle = `rgb(${118 + t * 30},${100 + t * 24},${76 + t * 18})`;
      dg.fillRect(i, -17 + rnd() * 2, 10, 34);
      dg.strokeStyle = INK;
      dg.lineWidth = 0.8;
      dg.strokeRect(i, -17, 10, 34);
      inkLine(
        dg,
        [
          [i + 4, -14],
          [i + 4, 12],
        ],
        0.5,
        "rgba(60,48,34,.45)",
      );
    }
    for (let i = 16; i <= DOCK_LEN; i += 44) {
      dg.fillStyle = "#4e3e2c";
      dg.fillRect(i, 15, 6, 14);
      dg.fillRect(i, -22, 6, 8);
      dg.strokeStyle = INK;
      dg.strokeRect(i, 15, 6, 14);
      dg.strokeRect(i, -22, 6, 8);
    }
    dg.strokeStyle = "rgba(86,70,50,.9)";
    dg.lineWidth = 1.4;
    dg.beginPath();
    dg.moveTo(0, -20);
    dg.lineTo(DOCK_LEN, -20);
    dg.stroke();
  });
  const boat = sprite(130, 120, 65, 100, (bg) => {
    bg.fillStyle = "rgba(20,40,55,.3)";
    bg.beginPath();
    bg.ellipse(6, 4, 52, 14, 0, 0, 7);
    bg.fill();
    bg.fillStyle = "#6b5438";
    bg.beginPath();
    bg.moveTo(-50, -10);
    bg.quadraticCurveTo(0, 16, 50, -10);
    bg.lineTo(42, -18);
    bg.lineTo(-42, -18);
    bg.closePath();
    bg.fill();
    bg.strokeStyle = INK;
    bg.lineWidth = 1.1;
    bg.stroke();
    for (let i = 0; i < 3; i++)
      inkLine(
        bg,
        [
          [-46 + i * 2, -12 + i * 3],
          [0, 6 + i * 3 - 4],
          [46 - i * 2, -12 + i * 3],
        ],
        0.6,
        "rgba(50,40,28,.5)",
      );
    bg.fillStyle = "#8f7a58";
    bg.fillRect(-40, -20, 80, 4);
    bg.strokeRect(-40, -20, 80, 4);
    bg.fillStyle = "#ddd3bb";
    bg.beginPath();
    bg.moveTo(2, -22);
    bg.lineTo(2, -88);
    bg.quadraticCurveTo(20, -60, 36, -26);
    bg.closePath();
    bg.fill();
    bg.stroke();
    bg.fillStyle = "rgba(120,100,70,.25)";
    bg.beginPath();
    bg.moveTo(2, -60);
    bg.quadraticCurveTo(18, -50, 30, -32);
    bg.lineTo(2, -30);
    bg.closePath();
    bg.fill();
    inkLine(
      bg,
      [
        [0, -20],
        [0, -94],
      ],
      2.4,
      "#4a3b2a",
    );
  });
  const ferry = sprite(90, 70, 45, 50, (fg) => {
    fg.fillStyle = "rgba(20,40,55,.3)";
    fg.beginPath();
    fg.ellipse(5, 4, 40, 10, 0, 0, 7);
    fg.fill();
    fg.fillStyle = "#5e4a34";
    fg.beginPath();
    fg.moveTo(-40, -6);
    fg.quadraticCurveTo(0, 12, 40, -6);
    fg.lineTo(34, -14);
    fg.lineTo(-34, -14);
    fg.closePath();
    fg.fill();
    fg.strokeStyle = INK;
    fg.lineWidth = 1;
    fg.stroke();
    fg.fillStyle = "#b9b2a3";
    fg.fillRect(-16, -32, 30, 18);
    fg.strokeRect(-16, -32, 30, 18);
    fg.fillStyle = "#7b6549";
    poly(fg, [
      [-20, -31],
      [0, -40],
      [18, -31],
    ]);
    fg.fill();
    fg.stroke();
    fg.fillStyle = "#3e3a36";
    fg.fillRect(4, -50, 5, 12);
  });
  const campStones = sprite(70, 40, 35, 22, (cg) => {
    for (let i = 0; i < 10; i++) {
      const a = (i / 10) * 6.28;
      cg.fillStyle = i % 2 ? "#8b8780" : "#a29e95";
      cg.beginPath();
      cg.ellipse(Math.cos(a) * 20, Math.sin(a) * 12, 5.5, 4, 0, 0, 7);
      cg.fill();
      cg.strokeStyle = INK;
      cg.lineWidth = 0.8;
      cg.stroke();
    }
    cg.strokeStyle = "#4a3b2a";
    cg.lineWidth = 4.5;
    cg.beginPath();
    cg.moveTo(-12, 5);
    cg.lineTo(12, -3);
    cg.moveTo(12, 5);
    cg.lineTo(-12, -3);
    cg.stroke();
  });
  return {
    rocks,
    trees,
    autumn,
    props,
    clouds,
    dock,
    boat,
    ferry,
    campStones,
    rnd,
  };
}
