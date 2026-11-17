// The Undercroft's painters: each thing in the cave drawn in world space from
// its data and a few live values (how lit, how awake, how open), adding the
// light it gives to the frame's light list rather than drawing it — the
// controller stamps every light at once, additively, over the scene.

import type { Ctx } from "../kit";
import {
  ARCH,
  CRYSTAL_HUES,
  DOOR_R,
  LAKE,
  SONG,
  floorY,
  type Mushroom,
} from "./cave";

/** A light some thing gives off: stamped additively after the scene. */
export interface Light {
  readonly x: number;
  readonly y: number;
  readonly r: number;
  /** One of LIGHT's colours (the glow stamps are cached per colour). */
  readonly col: string;
  readonly a: number;
}

/** The few light colours the cave uses: hue → a cached glow colour. */
export function lightCol(hue: number): string {
  const h = Math.round(hue / 30) * 30;
  return `hsla(${h},90%,62%,1)`;
}

export const INK_DARK = "rgba(4,8,10,.75)";

const hsl = (h: number, s: number, l: number, a = 1) =>
  `hsla(${h},${s}%,${Math.max(0, Math.min(100, l))}%,${a})`;

// ------------------------------------------------------------ mushrooms

export function paintMushroom(
  g: Ctx,
  m: Mushroom,
  glow: number,
  t: number,
  lights: Light[],
): void {
  const y = floorY(m.x) + (m.front ? 14 : 2);
  const sway = Math.sin(t * 0.7 + m.ph) * 0.02 * m.h;
  const cx = m.x + m.lean * m.h + sway;
  const cy = y - m.h;
  const sw = Math.max(2.5, m.r * 0.26);
  const dark = m.front ? -18 : 0;
  // the stem, a slight curve
  g.beginPath();
  g.moveTo(m.x - sw, y);
  g.quadraticCurveTo(
    m.x - sw * 0.6 + (cx - m.x) * 0.2,
    (y + cy) / 2,
    cx - sw * 0.7,
    cy,
  );
  g.lineTo(cx + sw * 0.7, cy);
  g.quadraticCurveTo(
    m.x + sw * 0.6 + (cx - m.x) * 0.2,
    (y + cy) / 2,
    m.x + sw,
    y,
  );
  g.closePath();
  const sg = g.createLinearGradient(m.x - sw, 0, m.x + sw, 0);
  sg.addColorStop(0, hsl(m.hue, 22, 46 + glow * 16 + dark));
  sg.addColorStop(1, hsl(m.hue, 22, 24 + glow * 10 + dark));
  g.fillStyle = sg;
  g.fill();
  g.strokeStyle = INK_DARK;
  g.lineWidth = 0.8;
  g.stroke();
  // the gills under the cap, glowing
  g.fillStyle = hsl(m.hue, 85, 50 + glow * 22 + dark, 0.9);
  g.beginPath();
  g.ellipse(cx, cy, m.r * 0.92, m.r * 0.2, 0, 0, 7);
  g.fill();
  // the cap: a dome lit from inside
  g.beginPath();
  g.moveTo(cx - m.r, cy);
  g.bezierCurveTo(
    cx - m.r,
    cy - m.r * 0.95,
    cx + m.r,
    cy - m.r * 0.95,
    cx + m.r,
    cy,
  );
  g.quadraticCurveTo(cx, cy + m.r * 0.16, cx - m.r, cy);
  g.closePath();
  const cg = g.createRadialGradient(
    cx - m.r * 0.25,
    cy - m.r * 0.5,
    m.r * 0.05,
    cx,
    cy - m.r * 0.2,
    m.r * 1.05,
  );
  cg.addColorStop(0, hsl(m.hue, 80, 62 + glow * 20 + dark));
  cg.addColorStop(0.6, hsl(m.hue, 70, 38 + glow * 18 + dark));
  cg.addColorStop(1, hsl(m.hue, 60, 18 + glow * 8 + dark));
  g.fillStyle = cg;
  g.fill();
  g.strokeStyle = INK_DARK;
  g.lineWidth = 1;
  g.stroke();
  // pale spots
  g.fillStyle = hsl(m.hue, 60, 80 + dark, 0.35 + glow * 0.4);
  for (let i = 0; i < 3; i++) {
    const a = m.ph + i * 2.1;
    g.beginPath();
    g.ellipse(
      cx + Math.cos(a) * m.r * 0.5,
      cy - m.r * (0.35 + 0.18 * Math.sin(a * 1.7)),
      m.r * 0.1,
      m.r * 0.07,
      0,
      0,
      7,
    );
    g.fill();
  }
  if (!m.front)
    lights.push({
      x: cx,
      y: cy - m.r * 0.2,
      r: m.r * (2.6 + glow * 2.4),
      col: lightCol(m.hue),
      a: 0.16 + glow * 0.3,
    });
}

// ------------------------------------------------------------ glowworm threads

export function paintThread(
  g: Ctx,
  x: number,
  top: number,
  len: number,
  ph: number,
  t: number,
  bright: number,
  lights: Light[],
): void {
  const sway = Math.sin(t * 0.5 + ph) * len * 0.04;
  g.strokeStyle = "rgba(170,225,225,.16)";
  g.lineWidth = 0.6;
  g.beginPath();
  g.moveTo(x, top);
  g.quadraticCurveTo(x, top + len * 0.5, x + sway, top + len);
  g.stroke();
  const n = Math.max(2, Math.floor(len / 8));
  for (let i = 1; i <= n; i++) {
    const k = i / n;
    const px = x + sway * k * k;
    const py = top + len * k;
    const tw = 0.55 + 0.45 * Math.sin(t * 1.3 + ph + i * 1.7);
    g.fillStyle = `rgba(150,255,240,${(0.25 + 0.5 * tw * k) * bright})`;
    g.beginPath();
    g.arc(px, py, i === n ? 1.9 : 0.9, 0, 7);
    g.fill();
  }
  lights.push({
    x: x + sway,
    y: top + len,
    r: 16 + len * 0.25,
    col: lightCol(170),
    a: 0.12 * bright,
  });
}

// ------------------------------------------------------------ crystals

export function paintCrystal(
  g: Ctx,
  x: number,
  i: number,
  glow: number,
  t: number,
  lights: Light[],
): void {
  const hue = CRYSTAL_HUES[i]!;
  const y = floorY(x) + 4;
  const shards: [number, number, number, number][] = [
    // dx, width, height, tilt
    [-18, 12, 46, -0.32],
    [16, 13, 52, 0.28],
    [-4, 18, 86 + i * 6, -0.05],
    [6, 10, 38, 0.5],
  ];
  const hum = 0.08 * Math.sin(t * 1.1 + i);
  for (const [dx, w, h, tilt] of shards) {
    g.save();
    g.translate(x + dx, y);
    g.rotate(tilt);
    const L = 30 + (glow + hum) * 40;
    // left face lit, right face in shade, a pointed tip
    g.beginPath();
    g.moveTo(-w / 2, 0);
    g.lineTo(-w / 2, -h);
    g.lineTo(0, -h - w * 0.9);
    g.lineTo(0, 0);
    g.closePath();
    g.fillStyle = hsl(hue, 70, L + 14, 0.92);
    g.fill();
    g.beginPath();
    g.moveTo(0, 0);
    g.lineTo(0, -h - w * 0.9);
    g.lineTo(w / 2, -h);
    g.lineTo(w / 2, 0);
    g.closePath();
    g.fillStyle = hsl(hue, 60, L - 6, 0.92);
    g.fill();
    g.beginPath();
    g.moveTo(-w / 2, 0);
    g.lineTo(-w / 2, -h);
    g.lineTo(0, -h - w * 0.9);
    g.lineTo(w / 2, -h);
    g.lineTo(w / 2, 0);
    g.strokeStyle = INK_DARK;
    g.lineWidth = 0.9;
    g.stroke();
    // a core of light up its middle
    g.strokeStyle = hsl(hue, 90, 80, 0.25 + glow * 0.6);
    g.lineWidth = 1.2;
    g.beginPath();
    g.moveTo(-w * 0.15, -4);
    g.lineTo(-w * 0.15, -h * 0.9);
    g.stroke();
    g.restore();
  }
  lights.push({
    x,
    y: y - 50,
    r: 60 + glow * 120,
    col: lightCol(hue),
    a: 0.18 + glow * 0.55,
  });
}

// ------------------------------------------------------------ the mural

/** The song as notes on a wall: lit up to `progress`, all of it once solved. */
export function paintMural(
  g: Ctx,
  x: number,
  y: number,
  progress: number,
  solved: boolean,
  t: number,
  lights: Light[],
): void {
  const w = 300;
  const h = 150;
  g.save();
  g.translate(x, y);
  // the slab, rough-edged
  g.beginPath();
  g.moveTo(-w / 2 + 6, -h / 2);
  g.lineTo(w / 2 - 10, -h / 2 + 4);
  g.lineTo(w / 2, h / 2 - 8);
  g.lineTo(-w / 2 + 12, h / 2);
  g.lineTo(-w / 2, -h / 2 + 18);
  g.closePath();
  g.fillStyle = "#1f2a2d";
  g.fill();
  g.strokeStyle = "rgba(120,150,150,.25)";
  g.lineWidth = 2;
  g.stroke();
  // the lake along the bottom, the well in the corner
  g.strokeStyle = "rgba(120,180,190,.35)";
  g.lineWidth = 1.4;
  g.beginPath();
  for (let i = 0; i <= 40; i++) {
    const px = -w / 2 + 20 + (i / 40) * (w - 40);
    const py = h / 2 - 22 + Math.sin(i * 0.9) * 3;
    if (i) g.lineTo(px, py);
    else g.moveTo(px, py);
  }
  g.stroke();
  g.strokeStyle = "rgba(200,190,160,.35)";
  g.strokeRect(-w / 2 + 18, -h / 2 + 16, 14, 10);
  g.beginPath();
  g.moveTo(-w / 2 + 14, -h / 2 + 16);
  g.lineTo(-w / 2 + 25, -h / 2 + 8);
  g.lineTo(-w / 2 + 36, -h / 2 + 16);
  g.stroke();
  // the song: five lights, higher for a higher crystal, joined like stars
  const pts = SONG.map((c, k) => [
    -w / 2 + 60 + k * ((w - 110) / (SONG.length - 1)),
    h / 2 - 44 - c * 13,
  ]) as [number, number][];
  g.setLineDash([3, 5]);
  g.strokeStyle = "rgba(220,220,200,.3)";
  g.lineWidth = 1.2;
  g.beginPath();
  pts.forEach(([px, py], k) => (k ? g.lineTo(px, py) : g.moveTo(px, py)));
  g.stroke();
  g.setLineDash([]);
  pts.forEach(([px, py], k) => {
    const hue = CRYSTAL_HUES[SONG[k]!]!;
    const lit = solved || k < progress;
    const tw = lit ? 1 : 0.55 + 0.15 * Math.sin(t * 2 + k);
    g.fillStyle = hsl(hue, 70, lit ? 70 : 42, tw);
    g.beginPath();
    g.arc(px, py, lit ? 7 : 5.5, 0, 7);
    g.fill();
    g.strokeStyle = "rgba(10,14,16,.7)";
    g.lineWidth = 1;
    g.stroke();
    if (lit)
      lights.push({ x: x + px, y: y + py, r: 34, col: lightCol(hue), a: 0.5 });
  });
  g.restore();
}

// ------------------------------------------------------------ the round door

/** The sealed round door: `open` 0 (shut) … 1 (rolled aside into its pocket). */
export function paintDoor(
  g: Ctx,
  x: number,
  progress: number,
  solved: boolean,
  open: number,
  t: number,
  lights: Light[],
): void {
  const fy = floorY(x);
  const cy = fy - DOOR_R;
  // the dark way through behind it, warm once it opens
  g.fillStyle = "#05090a";
  g.beginPath();
  g.ellipse(x, cy + 6, DOOR_R * 0.92, DOOR_R * 0.98, 0, 0, 7);
  g.fill();
  if (open > 0)
    lights.push({ x, y: cy, r: 160, col: lightCol(36), a: 0.45 * open });
  // the frame: two standing stones and a lintel
  g.fillStyle = "#1a2326";
  g.strokeStyle = INK_DARK;
  g.lineWidth = 1.2;
  for (const s of [-1, 1]) {
    g.beginPath();
    g.moveTo(x + s * (DOOR_R + 4), fy + 4);
    g.lineTo(x + s * (DOOR_R + 30), fy + 4);
    g.lineTo(x + s * (DOOR_R + 22), cy - 50);
    g.lineTo(x + s * (DOOR_R - 6), cy - 40);
    g.closePath();
    g.fill();
    g.stroke();
  }
  g.beginPath();
  g.moveTo(x - DOOR_R - 34, cy - 44);
  g.lineTo(x + DOOR_R + 34, cy - 50);
  g.lineTo(x + DOOR_R + 28, cy - 76);
  g.lineTo(x - DOOR_R - 26, cy - 70);
  g.closePath();
  g.fill();
  g.stroke();
  // the disc, rolling right into its pocket as it opens
  const roll = open * (DOOR_R * 2 + 30);
  const dx = x + roll;
  g.save();
  g.translate(dx, cy);
  g.rotate(roll / DOOR_R);
  const dg = g.createRadialGradient(-20, -24, 6, 0, 0, DOOR_R);
  dg.addColorStop(0, "#56656a");
  dg.addColorStop(1, "#263236");
  g.fillStyle = dg;
  g.beginPath();
  g.arc(0, 0, DOOR_R, 0, 7);
  g.fill();
  g.strokeStyle = INK_DARK;
  g.lineWidth = 2;
  g.stroke();
  // a carved spiral
  g.strokeStyle = "rgba(10,16,18,.55)";
  g.lineWidth = 3;
  g.beginPath();
  for (let a = 0; a < Math.PI * 7; a += 0.15) {
    const r = 6 + a * 2.6;
    const px = Math.cos(a) * r;
    const py = Math.sin(a) * r;
    if (a) g.lineTo(px, py);
    else g.moveTo(px, py);
  }
  g.stroke();
  // the sockets round the rim, lit as the song is played
  SONG.forEach((c, k) => {
    const a = -Math.PI / 2 + (k - (SONG.length - 1) / 2) * 0.5;
    const px = Math.cos(a) * (DOOR_R - 14);
    const py = Math.sin(a) * (DOOR_R - 14);
    const lit = solved || k < progress;
    g.fillStyle = lit ? hsl(CRYSTAL_HUES[c]!, 80, 66) : "#11181a";
    g.beginPath();
    g.arc(px, py, 6, 0, 7);
    g.fill();
    g.strokeStyle = "rgba(160,190,190,.3)";
    g.lineWidth = 1;
    g.stroke();
  });
  g.restore();
  if (!solved)
    SONG.forEach((c, k) => {
      if (k >= progress) return;
      const a = -Math.PI / 2 + (k - (SONG.length - 1) / 2) * 0.5;
      lights.push({
        x: x + Math.cos(a) * (DOOR_R - 14),
        y: cy + Math.sin(a) * (DOOR_R - 14),
        r: 26,
        col: lightCol(CRYSTAL_HUES[c]!),
        a: 0.6 + 0.2 * Math.sin(t * 3 + k),
      });
    });
}

// ------------------------------------------------------------ the keeper

/**
 * The Keeper: a great pale axolotl asleep on its ledge, facing the way the
 * hero comes. `awake` 0..1 opens its eyes and lights its gills.
 */
export function paintKeeper(
  g: Ctx,
  x: number,
  awake: number,
  talking: boolean,
  t: number,
  lights: Light[],
): void {
  const y = floorY(x) - 4;
  const breath = 1 + Math.sin(t * 1.2) * 0.025 * (1 - awake * 0.5);
  // the ledge it lies on
  g.fillStyle = "#162024";
  g.beginPath();
  g.moveTo(x - 150, y + 10);
  g.quadraticCurveTo(x - 120, y - 16, x - 20, y - 12);
  g.quadraticCurveTo(x + 120, y - 16, x + 170, y + 10);
  g.closePath();
  g.fill();
  g.save();
  g.translate(x, y - 10);
  // the tail, a curling fin behind
  const tailWag = Math.sin(t * 0.6) * 6;
  g.fillStyle = "#b98a96";
  g.beginPath();
  g.moveTo(40, -30);
  g.quadraticCurveTo(140, -50 + tailWag, 170, -14 + tailWag);
  g.quadraticCurveTo(130, -10, 60, -4);
  g.closePath();
  g.fill();
  g.strokeStyle = INK_DARK;
  g.lineWidth = 1.2;
  g.stroke();
  g.fillStyle = "rgba(240,190,205,.35)";
  g.beginPath();
  g.moveTo(60, -36);
  g.quadraticCurveTo(140, -66 + tailWag, 172, -16 + tailWag);
  g.quadraticCurveTo(140, -44 + tailWag, 60, -30);
  g.closePath();
  g.fill();
  // the legs, stubby with little fingers
  g.fillStyle = "#a87884";
  for (const lx of [-48, 52]) {
    g.beginPath();
    g.ellipse(lx, -6, 13, 7, 0.3, 0, 7);
    g.fill();
    g.stroke();
  }
  // the body, breathing
  g.save();
  g.scale(1, breath);
  const bg = g.createLinearGradient(0, -64, 0, 0);
  bg.addColorStop(0, "#d6a5b2");
  bg.addColorStop(1, "#8f6470");
  g.fillStyle = bg;
  g.beginPath();
  g.ellipse(12, -30, 92, 30, 0, 0, 7);
  g.fill();
  g.stroke();
  // speckles
  g.fillStyle = "rgba(120,70,90,.35)";
  for (let i = 0; i < 9; i++) {
    g.beginPath();
    g.ellipse(-50 + i * 14, -40 + Math.sin(i * 2.3) * 8, 3, 2, 0, 0, 7);
    g.fill();
  }
  g.restore();
  // the head, wide and flat, facing left
  const hx = -78;
  const hy = -40 - awake * 6;
  const hg = g.createRadialGradient(hx - 10, hy - 14, 4, hx, hy, 50);
  hg.addColorStop(0, "#e9bcc8");
  hg.addColorStop(1, "#a07380");
  g.fillStyle = hg;
  g.beginPath();
  g.ellipse(hx, hy, 50, 32, -0.05, 0, 7);
  g.fill();
  g.strokeStyle = INK_DARK;
  g.stroke();
  // the gills: three feathery fronds each side, fanned up and back behind the head, glowing as it wakes
  const gl = 0.3 + awake * 0.7;
  for (const side of [-1, 1]) {
    for (let k = 0; k < 3; k++) {
      const a =
        -1.75 +
        k * 0.5 +
        Math.sin(t * 1.6 + k * 1.3 + side) * 0.05 * (1 + awake);
      const bx = hx + 26 + side * 6;
      const by = hy - 12 + k * 7;
      const L = 26 + (k === 1 ? 6 : 0);
      const ex = bx + Math.cos(a) * L;
      const ey = by + Math.sin(a) * L;
      // the stalk, tapering
      g.strokeStyle = hsl(340, 55 + gl * 20, (side < 0 ? 38 : 48) + gl * 18);
      g.lineCap = "round";
      g.lineWidth = side < 0 ? 4 : 5;
      g.beginPath();
      g.moveTo(bx, by);
      g.lineTo(ex, ey);
      g.stroke();
      // soft filaments either side of it
      g.strokeStyle = hsl(340, 85, 62 + gl * 18, side < 0 ? 0.5 : 0.85);
      g.lineWidth = 1.6;
      const nx = -Math.sin(a);
      const ny = Math.cos(a);
      for (let f = 0.3; f <= 1.001; f += 0.14) {
        const fx = bx + (ex - bx) * f;
        const fy = by + (ey - by) * f;
        const fl = 4 + f * 3;
        g.beginPath();
        g.moveTo(fx + nx * fl, fy + ny * fl);
        g.lineTo(fx - nx * fl, fy - ny * fl);
        g.stroke();
      }
      if (side > 0 && k === 1)
        lights.push({
          x: x + ex,
          y: y - 10 + ey,
          r: 40 + awake * 50,
          col: lightCol(330),
          a: 0.25 + awake * 0.35,
        });
    }
  }
  // the eyes: shut lines asleep, round and shining awake
  for (const ex of [hx - 26, hx + 2]) {
    const ey = hy - 10;
    if (awake < 0.35) {
      g.strokeStyle = "rgba(40,20,28,.8)";
      g.lineWidth = 1.6;
      g.beginPath();
      g.arc(ex, ey - 2, 5, 0.2, Math.PI - 0.2);
      g.stroke();
    } else {
      const r = 3 + awake * 2.6;
      g.fillStyle = "#1a1014";
      g.beginPath();
      g.arc(ex, ey, r, 0, 7);
      g.fill();
      g.fillStyle = "rgba(255,255,255,.85)";
      g.beginPath();
      g.arc(ex - r * 0.35, ey - r * 0.35, r * 0.32, 0, 7);
      g.fill();
    }
  }
  // the smile, opening a little as it talks
  const open = talking ? (Math.sin(t * 14) * 0.5 + 0.5) * 4 : 0;
  g.strokeStyle = "rgba(60,30,40,.85)";
  g.lineWidth = 1.6;
  g.beginPath();
  g.moveTo(hx - 40, hy + 8);
  g.quadraticCurveTo(hx - 14, hy + 20 + open, hx + 14, hy + 10);
  g.stroke();
  g.restore();
  // asleep: z's drifting up
  if (awake < 0.3)
    for (let k = 0; k < 3; k++) {
      const p = (t * 0.35 + k / 3) % 1;
      g.fillStyle = `rgba(220,230,240,${(1 - p) * 0.6 * (1 - awake / 0.3)})`;
      g.font = `600 ${10 + p * 10}px Nunito, sans-serif`;
      g.fillText("z", x - 100 - p * 20 + Math.sin(p * 6) * 6, y - 80 - p * 70);
    }
}

// ------------------------------------------------------------ the arch over the lake

export function archUnder(x: number): number {
  const k = Math.sin((Math.PI * (x - ARCH.x0)) / (ARCH.x1 - ARCH.x0));
  const crown = 470 - ARCH.rise + 34;
  return (
    LAKE.surface +
    6 -
    (LAKE.surface + 6 - crown) * Math.pow(Math.max(0, k), 0.6)
  );
}

export function paintArch(g: Ctx): void {
  const N = 60;
  const top: [number, number][] = [];
  const under: [number, number][] = [];
  for (let i = 0; i <= N; i++) {
    const x = ARCH.x0 - 30 + ((ARCH.x1 - ARCH.x0 + 60) * i) / N;
    top.push([x, floorY(Math.max(ARCH.x0, Math.min(ARCH.x1, x))) + 2]);
    under.push([x, Math.max(floorY(x) + 16, archUnder(x))]);
  }
  g.beginPath();
  top.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)));
  for (let i = under.length - 1; i >= 0; i--)
    g.lineTo(under[i]![0], under[i]![1]);
  g.closePath();
  const sg = g.createLinearGradient(0, 380, 0, 540);
  sg.addColorStop(0, "#3a4a4e");
  sg.addColorStop(1, "#1a2427");
  g.fillStyle = sg;
  g.fill();
  g.strokeStyle = INK_DARK;
  g.lineWidth = 1.4;
  g.stroke();
  // the voussoirs: stones radiating from the arch's curve
  g.strokeStyle = "rgba(8,12,14,.5)";
  g.lineWidth = 1;
  for (let i = 1; i < N; i += 3) {
    const [x, uy] = under[i]!;
    const ty = top[i]![1];
    g.beginPath();
    g.moveTo(x, uy);
    g.lineTo(x + (x - (ARCH.x0 + ARCH.x1) / 2) * 0.03, ty + 4);
    g.stroke();
  }
  // its walking edge, catching the light
  g.strokeStyle = "rgba(160,200,200,.25)";
  g.lineWidth = 2;
  g.beginPath();
  top.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)));
  g.stroke();
}

// ------------------------------------------------------------ a lantern on a root

export function paintRoot(
  g: Ctx,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  w: number,
): void {
  const mx = (x0 + x1) / 2 + (x0 - x1) * 0.4;
  g.strokeStyle = "#2b1f17";
  g.lineCap = "round";
  g.lineWidth = w;
  g.beginPath();
  g.moveTo(x0, y0);
  g.quadraticCurveTo(mx, (y0 + y1) / 2, x1, y1);
  g.stroke();
  g.strokeStyle = "rgba(200,150,90,.18)";
  g.lineWidth = w * 0.3;
  g.beginPath();
  g.moveTo(x0 - w * 0.2, y0);
  g.quadraticCurveTo(mx - w * 0.2, (y0 + y1) / 2, x1 - w * 0.2, y1);
  g.stroke();
}

/** A lantern hanging at (x, y) (its ring), lit `bright` 0..1 in the app's colour. */
export function paintLantern(
  g: Ctx,
  x: number,
  y: number,
  swing: number,
  hue: string,
  glyph: CanvasImageSource,
  bright: number,
  lights: Light[],
): void {
  g.save();
  g.translate(x, y);
  g.rotate(swing);
  g.strokeStyle = "#1a1410";
  g.lineWidth = 1.4;
  g.beginPath();
  g.arc(0, 2, 3, 0, 7);
  g.moveTo(0, 5);
  g.lineTo(0, 10);
  g.stroke();
  // the glass, glowing in the app's own colour
  const gx = -15;
  const gy = 16;
  const gw = 30;
  const gh = 36;
  g.fillStyle = "#0d0a08";
  g.beginPath();
  g.roundRect(gx, gy, gw, gh, 6);
  g.fill();
  g.globalAlpha = 0.3 + bright * 0.7;
  const lg = g.createRadialGradient(
    0,
    gy + gh / 2,
    2,
    0,
    gy + gh / 2,
    gh * 0.75,
  );
  lg.addColorStop(0, "#fff4dc");
  lg.addColorStop(0.45, hue);
  lg.addColorStop(1, "rgba(0,0,0,.6)");
  g.fillStyle = lg;
  g.beginPath();
  g.roundRect(gx + 2, gy + 2, gw - 4, gh - 4, 5);
  g.fill();
  g.globalAlpha = 0.55 + bright * 0.45;
  g.drawImage(glyph, -9, gy + gh / 2 - 9, 18, 18);
  g.globalAlpha = 1;
  // the frame: cap, bars, base
  g.fillStyle = "#2a201a";
  g.beginPath();
  g.moveTo(-10, 10);
  g.lineTo(10, 10);
  g.lineTo(17, gy + 1);
  g.lineTo(-17, gy + 1);
  g.closePath();
  g.fill();
  g.fillRect(-17, gy + gh - 2, 34, 5);
  g.strokeStyle = "#2a201a";
  g.lineWidth = 1.4;
  g.beginPath();
  g.moveTo(gx + 1, gy);
  g.lineTo(gx + 1, gy + gh);
  g.moveTo(gx + gw - 1, gy);
  g.lineTo(gx + gw - 1, gy + gh);
  g.stroke();
  g.restore();
  lights.push({
    x: x + Math.sin(swing) * -34,
    y: y + 34,
    r: 50 + bright * 70,
    col: lightCol(40),
    a: 0.2 + bright * 0.4,
  });
}

// ------------------------------------------------------------ the island's heart

export function paintHeart(
  g: Ctx,
  x: number,
  y: number,
  beat: number,
  t: number,
  lights: Light[],
): void {
  const s = 1 + beat * 0.05;
  g.save();
  g.translate(x, y);
  g.scale(s, s);
  const hg = g.createRadialGradient(-14, -20, 4, 0, 0, 72);
  hg.addColorStop(0, "#fff1c4");
  hg.addColorStop(0.35, "#ffc76a");
  hg.addColorStop(0.8, "#c2652c");
  hg.addColorStop(1, "#5a2a14");
  g.fillStyle = hg;
  g.beginPath();
  g.moveTo(0, -78);
  g.bezierCurveTo(46, -70, 58, -10, 44, 30);
  g.bezierCurveTo(30, 66, -30, 66, -44, 30);
  g.bezierCurveTo(-58, -10, -46, -70, 0, -78);
  g.closePath();
  g.fill();
  g.strokeStyle = "rgba(60,24,10,.8)";
  g.lineWidth = 2;
  g.stroke();
  // veins of light inside
  g.strokeStyle = `rgba(255,250,220,${0.35 + beat * 0.4})`;
  g.lineWidth = 1.4;
  for (let k = 0; k < 5; k++) {
    const a = -1.2 + k * 0.6;
    g.beginPath();
    g.moveTo(0, -60);
    g.quadraticCurveTo(
      Math.cos(a) * 30,
      0,
      Math.cos(a) * 26,
      40 + Math.sin(t + k) * 2,
    );
    g.stroke();
  }
  g.restore();
  lights.push({
    x,
    y,
    r: 230 + beat * 80,
    col: lightCol(36),
    a: 0.5 + beat * 0.3,
  });
  lights.push({ x, y: y - 10, r: 80, col: lightCol(48), a: 0.6 + beat * 0.4 });
}

/** The heart's double beat (lub-dub), 0..1, every `period` s. */
export function heartBeat(t: number, period = 2.4): number {
  const p = (t % period) / period;
  const pulse = (c: number, w: number) => Math.exp(-(((p - c) / w) ** 2));
  return Math.min(1, pulse(0.08, 0.04) + 0.7 * pulse(0.2, 0.045));
}

/** The iris: everything black but a round hole of radius `r` at (cx, cy) (screen px). */
export function paintIris(
  g: Ctx,
  vw: number,
  vh: number,
  cx: number,
  cy: number,
  r: number,
): void {
  g.fillStyle = "#020405";
  g.beginPath();
  g.rect(0, 0, vw, vh);
  g.moveTo(cx + Math.max(0, r), cy);
  g.arc(cx, cy, Math.max(0, r), 0, Math.PI * 2, true);
  g.fill("evenodd");
}
