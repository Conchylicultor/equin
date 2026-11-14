// Paints a planned building: walls by archetype, roof, door and porch, the
// chimney, the bracket sign, the props, the foliage. It only reads the plan —
// everything painting decides lives in the plan or in the random stream.

import type { Ctx2D, PaintState } from "../spec";
import { accent, at, dark, jit, type Rnd } from "./colour";
import {
  bbox,
  castShadow,
  grain,
  hline,
  ink,
  ivy,
  moss,
  planks,
  poly,
  shrub,
  stones,
  thatch,
  tufts,
  wash,
  type Pt,
} from "./draw";
import {
  annexOf,
  doorHeight,
  doorWidth,
  grainBox,
  propsAnchor,
  roofShape,
  shadowPts,
  wallHeight,
  windowSlots,
} from "./layout";
import { doorArch, lantern, windowRect } from "./parts";
import type { Plan } from "./plan";
import { flowerBox, paintProps } from "./props";
import { paintRoof, roofCover, smallRoof, wallFill } from "./walls";

/** A chimney whose base is on the roof at (x, y). */
function chimneyAt(g: Ctx2D, x: number, y: number, r: Rnd): void {
  const w = 14;
  const h = 34;
  stones(g, x - w / 2, y - h, x + w / 2, y + 4, r, {
    rowH: 6,
    blockW: 8,
    base: "#a59d8b",
  });
  g.fillStyle = "#6f6a60";
  g.fillRect(x - w / 2 - 2, y - h - 4, w + 4, 5);
  ink(g, 1);
  g.strokeRect(x - w / 2 - 2, y - h - 4, w + 4, 5);
  g.fillStyle = "#2a2622";
  g.fillRect(x - 4, y - h - 4, 8, 2);
}

function doorAt(
  g: Ctx2D,
  x: number,
  h: number,
  w: number,
  p: Plan,
  r: Rnd,
  A: string,
): void {
  if (p.arched) {
    doorArch(g, x, 0, w, h, r, {
      col: A,
      surround: p.wall === "rubble" || p.wall === "ashlar",
    });
  } else {
    g.save();
    g.beginPath();
    g.rect(x - w / 2, -h, w, h);
    g.clip();
    planks(g, x - w / 2, -h, x + w / 2, 0, r, { base: A, pw: 6 });
    g.restore();
    g.strokeStyle = "#5a4632";
    g.lineWidth = 4;
    g.strokeRect(x - w / 2 - 2, -h - 2, w + 4, h + 2);
    ink(g, 1.3);
    g.strokeRect(x - w / 2 - 4, -h - 4, w + 8, h + 4);
    g.fillStyle = "#c2a060";
    g.beginPath();
    g.arc(x + w * 0.3, -h * 0.45, 1.6, 0, 7);
    g.fill();
  }
  // a worn step
  g.fillStyle = jit("#a49d8c", r, 10);
  g.fillRect(x - w / 2 - 6, -2, w + 12, 5);
  ink(g, 0.9, 0.6);
  g.strokeRect(x - w / 2 - 6, -2, w + 12, 5);
}

function porchAt(
  g: Ctx2D,
  x: number,
  doorH: number,
  w: number,
  p: Plan,
  r: Rnd,
  A: string,
): void {
  const y = -doorH - 8;
  const roof = smallRoof(p.roof);
  if (p.porch === "awning") {
    const aw: Pt[] = [
      [x - w, y],
      [x + w, y],
      [x + w + 8, y + 16],
      [x - w - 8, y + 16],
    ];
    wash(g, () => poly(g, aw), bbox(aw), "#b9ac8a", r, { blob: 4, var: 16 });
    for (let k = 0; k < 4; k++) {
      const a = x - w + (k * w) / 2;
      g.fillStyle = dark(A, 0.1, 0.5);
      poly(g, [
        [a, y],
        [a + w / 4, y],
        [a + w / 4 + 2 + k * 1.2, y + 16],
        [a + 2 + k * 1.2, y + 16],
      ]);
      g.fill();
    }
    ink(g, 0.9, 0.6);
    for (let xx = x - w - 8; xx < x + w + 8; xx += 6) {
      g.beginPath();
      g.arc(xx + 3, y + 16, 3, 0, Math.PI);
      g.stroke();
    }
  } else if (p.porch === "porch") {
    for (const px of [x - w + 2, x + w - 6]) {
      planks(g, px, y + 2, px + 4, 4, r, { base: "#6e5a46", pw: 4 });
    }
    roofCover(
      g,
      roof,
      [
        [x - w - 8, y + 4],
        [x + w + 8, y + 4],
        [x + w, y - 14],
        [x - w, y - 14],
      ],
      r,
    );
  } else if (p.porch === "hood") {
    roofCover(
      g,
      roof,
      [
        [x - w + 4, y + 2],
        [x + w - 4, y + 2],
        [x, y - 14],
      ],
      r,
    );
    g.strokeStyle = "#5a4632";
    g.lineWidth = 2.5;
    g.beginPath();
    g.moveTo(x - w + 8, y + 2);
    g.lineTo(x - w + 14, y + 12);
    g.moveTo(x + w - 8, y + 2);
    g.lineTo(x + w - 14, y + 12);
    g.stroke();
  }
}

/** A hanging iron bracket sign with the app's glyph on a small board. */
function bracketSign(
  g: Ctx2D,
  x: number,
  y: number,
  dir: -1 | 1,
  s: PaintState,
  r: Rnd,
): void {
  g.strokeStyle = "#2e2a26";
  g.lineWidth = 2;
  g.beginPath();
  g.moveTo(x, y);
  g.lineTo(x + dir * 26, y);
  g.moveTo(x, y + 8);
  g.lineTo(x + dir * 14, y);
  g.stroke();
  const bx = x + dir * 18;
  ink(g, 0.8, 0.7);
  hline(g, bx - 6, y, bx - 6, y + 5, r);
  hline(g, bx + 6, y, bx + 6, y + 5, r);
  wash(
    g,
    () => {
      g.beginPath();
      g.rect(bx - 10, y + 5, 20, 18);
    },
    [bx - 10, y + 5, bx + 10, y + 23],
    "#d8c9a4",
    r,
    { blob: 3, stipple: 10 },
  );
  g.save();
  g.fillStyle = "rgba(52,40,28,.85)";
  s.glyph(g, bx, y + 14.5, 15);
  g.restore();
}

/** Paints the whole building planned in `p` into `g` (door at the origin). */
export function paintBuilding(g: Ctx2D, s: PaintState, p: Plan): void {
  const r: Rnd = () => s.rnd();
  const A = accent(s.hue);
  const { W2 } = p;
  const night = s.night;
  const wallH = wallHeight(p);
  const WT = -wallH;
  // cast shadow first
  castShadow(g, shadowPts(p), 0.26);
  let chim: { chimX: number; chimY: number } | null = null;
  // annex (lean-to) first so the main body overlaps its inner edge
  const annex = annexOf(p);
  if (annex) {
    const { x0: ax0, x1: ax1, h: aH } = annex;
    if (p.arch === "workshop") {
      // open bay
      wallFill(g, ax0, -aH, ax1, 0, r, annex.wall);
      const bx0 = ax0 + 6;
      const bx1 = ax1 - 6;
      g.fillStyle = "#2a241e";
      g.fillRect(bx0, -aH + 10, bx1 - bx0, aH - 10);
      g.fillStyle = night ? "rgba(255,190,110,.35)" : "rgba(120,100,70,.25)";
      g.fillRect(bx0, -aH + 10, bx1 - bx0, aH - 10);
      planks(g, bx0 + 3, -16, bx1 - 3, -11, r, {
        base: "#7b6549",
        vertical: false,
        pw: 5,
      });
      g.fillStyle = "#5a4632";
      g.fillRect(bx0 + 5, -11, 3, 11);
      g.fillRect(bx1 - 8, -11, 3, 11);
      for (let k = 0; k < 3; k++) {
        g.strokeStyle = "#8a8070";
        g.lineWidth = 1.6;
        const tx = bx0 + 8 + (k * (bx1 - bx0 - 16)) / 2;
        g.beginPath();
        g.moveTo(tx, -aH + 14);
        g.lineTo(tx, -aH + 26);
        g.stroke();
      }
      ink(g, 1.3);
      g.strokeRect(bx0, -aH + 10, bx1 - bx0, aH - 10);
    } else wallFill(g, ax0, -aH, ax1, 0, r, annex.wall);
    roofCover(g, p.roof, annex.roof, r);
  }
  if (p.arch === "tower") {
    const path = () => {
      g.beginPath();
      g.moveTo(-W2, 0);
      g.lineTo(-W2 + 3, WT);
      g.lineTo(W2 - 3, WT);
      g.lineTo(W2, 0);
      g.ellipse(0, 0, W2, W2 * 0.18, 0, 0, Math.PI);
      g.closePath();
    };
    wallFill(g, -W2, WT, W2, 4, r, p.wall, path);
    const cyl = g.createLinearGradient(-W2, 0, W2, 0);
    cyl.addColorStop(0, "rgba(255,248,230,.10)");
    cyl.addColorStop(0.35, "rgba(0,0,0,0)");
    cyl.addColorStop(1, "rgba(25,22,18,.32)");
    g.save();
    path();
    g.clip();
    g.fillStyle = cyl;
    g.fillRect(-W2, WT, 2 * W2, -WT + 6);
    g.restore();
    path();
    ink(g, 1.4);
    g.stroke();
    // string course + windows up the tower
    g.fillStyle = "#8f8878";
    g.fillRect(-W2 + 2, WT * 0.55 - 3, 2 * W2 - 4, 5);
    ink(g, 0.9, 0.6);
    g.strokeRect(-W2 + 2, WT * 0.55 - 3, 2 * W2 - 4, 5);
    windowRect(g, -6, WT * 0.62, 12, 18, r, { lit: night, arch: true });
    windowRect(g, -6, WT * 0.25 + 4, 12, 16, r, { lit: night, arch: true });
    // cone roof
    const ch = Math.round(W2 * 1.5 + 20);
    const cone: Pt[] = [
      [-W2 - 10, WT + 6],
      [0, WT - ch],
      [W2 + 10, WT + 6],
    ];
    roofCover(g, p.roof, cone, r);
    g.save();
    poly(g, cone);
    g.clip();
    g.fillStyle = "rgba(20,18,15,.22)";
    poly(g, [
      [0, WT - ch],
      [W2 + 10, WT + 6],
      [W2 * 0.2, WT + 6],
    ]);
    g.fill();
    g.restore();
    g.fillStyle = "#55585e";
    g.beginPath();
    g.ellipse(0, WT + 6, W2 + 10, 5, 0, 0, Math.PI);
    g.fill();
    ink(g, 1);
    g.stroke();
    g.strokeStyle = "#3a352f";
    g.lineWidth = 1.6;
    g.beginPath();
    g.moveTo(0, WT - ch);
    g.lineTo(0, WT - ch - 14);
    g.stroke();
    g.fillStyle = A;
    poly(g, [
      [0, WT - ch - 14],
      [11, WT - ch - 11],
      [0, WT - ch - 8],
    ]);
    g.fill();
    ink(g, 0.7);
    g.stroke();
  } else if (p.arch === "hut") {
    const path = () => {
      g.beginPath();
      g.moveTo(-W2, 0);
      g.lineTo(-W2, WT);
      g.lineTo(W2, WT);
      g.lineTo(W2, 0);
      g.ellipse(0, 0, W2, W2 * 0.2, 0, 0, Math.PI);
      g.closePath();
    };
    wallFill(g, -W2, WT, W2, 6, r, p.wall, path);
    const cyl = g.createLinearGradient(-W2, 0, W2, 0);
    cyl.addColorStop(0, "rgba(255,248,230,.10)");
    cyl.addColorStop(0.4, "rgba(0,0,0,0)");
    cyl.addColorStop(1, "rgba(25,22,18,.32)");
    g.save();
    path();
    g.clip();
    g.fillStyle = cyl;
    g.fillRect(-W2, WT, 2 * W2, -WT + 10);
    g.restore();
    path();
    ink(g, 1.4);
    g.stroke();
    for (const wx of [-W2 * 0.6, W2 * 0.6]) {
      windowRect(g, wx - 7, -14, 14, 16, r, { lit: night, arch: true });
    }
    // the big thatched dome
    const R2 = W2 + 14;
    const dh = Math.round(W2 * 1.05 + 20);
    const dome: Pt[] = [];
    for (let i = 0; i <= 24; i++) {
      const a = Math.PI + (i / 24) * Math.PI;
      dome.push([Math.cos(a) * R2, WT + 10 + Math.sin(a) * dh]);
    }
    for (let i = 0; i <= 12; i++) {
      const a = (i / 12) * Math.PI;
      dome.push([Math.cos(a) * R2, WT + 10 + Math.sin(a) * 10]);
    }
    thatch(g, dome, r, null);
    g.save();
    poly(g, dome);
    g.clip();
    g.fillStyle = "rgba(20,18,15,.2)";
    g.beginPath();
    g.ellipse(R2 * 0.5, WT - dh * 0.2, R2 * 0.7, dh, 0, 0, 7);
    g.fill();
    g.restore();
    for (let x = -R2 + 2; x < R2; x += 2.4) {
      const yy = WT + 10 + Math.sqrt(Math.max(0, 1 - (x / R2) ** 2)) * 10;
      g.strokeStyle = at(["#a48a52", "#7f6a3d", "#c2a86a"], (r() * 3) | 0);
      g.lineWidth = 1.2;
      g.beginPath();
      g.moveTo(x, yy - 4);
      g.lineTo(x + (r() - 0.5) * 2, yy + 2 + r() * 4);
      g.stroke();
    }
    // a little cupola
    stones(g, -7, WT + 10 - dh - 12, 7, WT + 10 - dh + 6, r, {
      rowH: 5,
      blockW: 7,
    });
    g.fillStyle = "#6d7178";
    poly(g, [
      [-11, WT + 10 - dh - 10],
      [0, WT + 10 - dh - 24],
      [11, WT + 10 - dh - 10],
    ]);
    g.fill();
    ink(g, 1);
    g.stroke();
  } else {
    const x0 = -W2;
    const x1 = W2;
    // the roof goes behind the wall top, then the wall
    const R = roofShape(p, x0, x1, WT);
    paintRoof(g, R, p, r, night);
    wallFill(g, x0, WT, x1, 0, r, p.wall);
    // ground-floor plinth for timber/plaster/planks/logs
    if (!(p.wall === "rubble" || p.wall === "ashlar")) {
      stones(g, x0, -12, x1, 0, r, { rowH: 6, blockW: 14, base: "#a59d8b" });
    }
    if (p.storeys === 2) {
      g.fillStyle = "#8f8878";
      g.fillRect(x0, WT / 2 - 3, x1 - x0, 5);
      ink(g, 0.9, 0.6);
      g.strokeRect(x0, WT / 2 - 3, x1 - x0, 5);
    }
    // windows
    for (const w of windowSlots(p)) {
      windowRect(g, w.x, w.y, 24, w.h, r, {
        lit: night,
        arch: p.winArch,
        shutters: p.shutters ? A : null,
      });
      if (p.flowerBoxes && w.y > -40) flowerBox(g, w.x - 2, w.y + 2, 28, r);
    }
    if (p.storeys === 2)
      windowRect(g, -10, WT / 2 - 10, 20, 22, r, {
        lit: night,
        arch: p.winArch,
      });
    chim = p.chimney ? R : null;
  }
  // door, porch, signs
  const dH = doorHeight(p);
  const dW = doorWidth(p);
  if (p.arch === "storehouse") {
    // wide double doors, ajar, X-braced
    const w = Math.min(64, W2);
    const h = Math.min(54, wallH - 8);
    g.fillStyle = "#211c17";
    g.fillRect(-w / 2, -h, w, h);
    if (night) {
      g.fillStyle = "rgba(255,190,110,.35)";
      g.fillRect(-w / 2, -h, w, h);
    }
    for (let k = 0; k < 3; k++) {
      g.fillStyle = "#5a4632";
      g.fillRect(-w / 2 + 6, -h + 10 + k * 14, w - 12, 2);
      for (let j = 0; j < 5; j++) {
        g.fillStyle = at(
          ["#7a6040", "#8e7a52", "#6a5a44", "#a08a62"],
          (r() * 4) | 0,
        );
        g.fillRect(
          -w / 2 + 8 + (j * (w - 16)) / 5,
          -h + 3 + k * 14,
          (w - 16) / 5 - 2,
          7,
        );
      }
    }
    for (const [a, b] of [
      [-w / 2 - 14, -w / 2 + 6],
      [w / 2 - 6, w / 2 + 14],
    ] as const) {
      planks(g, a, -h, b, 0, r, { base: A, pw: 5 });
      ink(g, 1.4);
      g.beginPath();
      g.moveTo(a + 2, -2);
      g.lineTo(b - 2, -h + 2);
      g.stroke();
    }
    ink(g, 1.4);
    g.strokeRect(-w / 2, -h, w, h);
    g.fillStyle = "#5a4632";
    g.fillRect(-w / 2 - 4, -h - 6, w + 8, 6);
    ink(g, 1);
    g.strokeRect(-w / 2 - 4, -h - 6, w + 8, 6);
  } else {
    porchAt(g, 0, dH, dW, p, r, A);
    doorAt(g, 0, dH, dW, p, r, A);
  }
  if (chim) chimneyAt(g, chim.chimX, chim.chimY, r);
  // ivy, moss, tufts, shrubs
  if (p.ivy) ivy(g, p.ivy * (W2 - 10), -2, -wallH * 0.85, r, 22);
  moss(g, -W2, W2, 0, r, 10);
  tufts(g, -W2 - 10, W2 + 10, 2, r, 18);
  const bracketX = p.signBracket * (W2 - 2);
  bracketSign(
    g,
    bracketX,
    -dH - (p.arch === "tower" ? 30 : 6),
    p.signBracket,
    s,
    r,
  );
  paintProps(g, p, propsAnchor(p), r, A, night);
  for (let i = 0; i < p.shrubs; i++) {
    const sx = (i % 2 ? 1 : -1) * (W2 * (0.3 + r() * 0.5));
    const sy = 10 + r() * 14;
    if (Math.abs(sx) < 26) continue;
    shrub(g, sx, sy, 8 + r() * 6, r, (r() * 3) | 0);
  }
  if (p.cat === "music" || p.cat === "life")
    lantern(g, -p.signBracket * 18, -dH - 12, night);
  grain(g, grainBox(p), r);
}
