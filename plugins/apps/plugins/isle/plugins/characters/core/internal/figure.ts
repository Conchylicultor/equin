// One figure: the skeletal body in a view (front / back / side), hip-up from a ground line at y = 0.

import type { Ctx2D } from "@plugins/apps/plugins/isle/plugins/buildings/core";
import { mix } from "./colour";
import {
  capsule,
  crease,
  ell,
  INK,
  limb,
  part,
  poly,
  seam,
  smooth,
  softLine,
  TAU,
  unit,
  type Path,
  type Point,
  type Seg,
} from "./draw-parts";
import { gait, type FigurePose, type Gait } from "./gait";
import { frontHead, sideHead } from "./heads";
import type { Look } from "./looks";

export type View = "front" | "back" | "side";

function basket(g: Ctx2D, x: number, y: number, lag: number): void {
  g.save();
  g.translate(x, y);
  g.rotate(lag * 0.06);
  g.strokeStyle = "#6a4f30";
  g.lineWidth = 0.7;
  g.beginPath();
  g.arc(0, 0, 2.6, Math.PI * 1.05, Math.PI * 1.95);
  g.stroke();
  part(
    g,
    smooth([
      [-3.4, 0.2],
      [3.4, 0.2],
      [2.6, 3.6],
      [-2.6, 3.6],
    ]),
    "#a07c4c",
    { off: 0.6 },
  );
  g.strokeStyle = "rgba(60,40,20,.5)";
  g.lineWidth = 0.35;
  for (let i = -2; i <= 2; i++) {
    g.beginPath();
    g.moveTo(i * 1.2, 0.5);
    g.lineTo(i * 1, 3.3);
    g.stroke();
  }
  g.fillStyle = "#7d8a46";
  g.beginPath();
  g.arc(-1.2, -0.2, 1, 0, TAU);
  g.arc(1, -0.1, 0.9, 0, TAU);
  g.fill();
  g.restore();
}

interface Dims {
  readonly h: number;
  readonly w: number;
  readonly T: number;
  readonly S: number;
  readonly U: number;
  readonly F: number;
  readonly torso: number;
  readonly neck: number;
  readonly hr: number;
  readonly hy: number;
}

export function figure(g: Ctx2D, L: Look, view: View, pose: FigurePose): void {
  const G = gait(L, pose);
  const h = L.h;
  const d: Dims = {
    h,
    w: L.w,
    T: 9.6 * h,
    S: 9.6 * h,
    U: 7.0 * h,
    F: 6.6 * h,
    torso: 12.4 * h + G.breath * 0.25,
    neck: 1.7 * h,
    hr: 3.75 * L.head,
    hy: 4.4 * L.head,
  };
  if (view === "side") sideFigure(g, L, pose, G, d);
  else frontFigure(g, L, view === "back", pose, G, d);
}

function sideFigure(
  g: Ctx2D,
  L: Look,
  pose: FigurePose,
  G: Gait,
  d: Dims,
): void {
  const { h, w, T, S, U, F, torso, neck, hr, hy } = d;
  const skin = L.skin;
  // legs, from a hip at y=0, then lift the whole body so the lowest foot touches the ground
  const legPts = G.legs.map((l) => {
    const k: Point = [Math.sin(l.th) * T, Math.cos(l.th) * T];
    const sa = l.th - l.kn;
    const a: Point = [k[0] + Math.sin(sa) * S, k[1] + Math.cos(sa) * S];
    return { k, a, sa, kn: l.kn };
  });
  const ground = Math.max(...legPts.map((l) => l.a[1])) + 1.7;
  const hipY = -ground;
  const lean = L.lean + (pose.mode === "walk" ? 0.03 : 0);
  const hip: Point = [0, hipY];
  const sh: Point = [
    hip[0] + Math.sin(lean) * torso,
    hip[1] - Math.cos(lean) * torso,
  ];
  const nk: Point = [sh[0] + Math.sin(lean * 0.6) * neck, sh[1] - neck];
  const head: Point = [
    nk[0] + 0.6 + Math.sin(lean * 0.4) * 1.5,
    nk[1] - hy * 0.85,
  ];
  const bx = (k: number, f: number) => hip[0] + (sh[0] - hip[0]) * k + f;
  const by = (k: number) => hip[1] + (sh[1] - hip[1]) * k;
  // a leg is ONE shape: shoe, thigh and shin (and, for the near leg, the seat of the trousers) under one outline
  const drawLeg = (
    l: (typeof legPts)[number],
    far: boolean,
    pelvis: Path | null,
  ) => {
    const k: Point = [hip[0] + l.k[0], hip[1] + l.k[1]];
    const a: Point = [hip[0] + l.a[0], hip[1] + l.a[1]];
    const col = far ? mix(L.bottom, -0.22) : L.bottom;
    const shoe = far ? mix(L.shoe, -0.2) : L.shoe;
    // shoe: heel at the ankle, toe forward, tipping with the shin while the foot is in the air
    const lift = Math.max(0, -l.a[1] - (-ground + 1.7));
    const fa =
      Math.max(-0.55, Math.min(0.35, l.sa * 0.55)) *
      Math.min(1, lift / 2 + 0.3);
    const toe: Point = [
      a[0] + Math.cos(fa) * 4.6,
      a[1] + 1.1 + Math.sin(fa) * 4.6,
    ];
    const segs: Seg[] = [
      {
        p: smooth([
          [a[0] - 1.4, a[1] - 0.7],
          [a[0] + 0.9, a[1] - 0.9],
          [toe[0] + 0.4, toe[1] - 0.9],
          [toe[0] + 0.6, toe[1] + 0.5],
          [a[0] - 1.5, a[1] + 1.4],
        ]),
        c: shoe,
      },
      { p: capsule(hip[0], hip[1], k[0], k[1], 2.9 * w, 2.15 * w), c: col },
      { p: capsule(k[0], k[1], a[0], a[1], 2.15 * w, 1.5 * w), c: col },
    ];
    if (pelvis) segs.push({ p: pelvis, c: L.bottom });
    limb(g, segs, { off: 0.75 });
    crease(g, k, hip, a, 2.1 * w, l.kn);
    const th = unit(hip, k);
    const shin = unit(k, a);
    // a loose drape fold down the thigh, and the trouser cuff resting on the shoe
    softLine(
      g,
      [hip[0] + th[0] * 3 - th[1] * 1.2, hip[1] + th[1] * 3 + th[0] * 1.2],
      [hip[0] + th[0] * 5.5 - th[1] * 0.2, hip[1] + th[1] * 5.5],
      [k[0] - th[0] * 1.2 + th[1] * 1.1, k[1] - th[1] * 1.2 - th[0] * 1.1],
      0.14,
    );
    seam(g, [a[0] - shin[0] * 0.5, a[1] - shin[1] * 0.5], shin, 1.5 * w, 0.26);
  };
  const shoulderX = sh[0] - 0.3;
  const shJ: Point = [shoulderX, sh[1] + 0.9];
  // an arm is ONE shape: hand, forearm, upper arm (a short sleeve lies over it); the near arm grows out of the torso
  const drawArm = (
    ar: Gait["arms"][number],
    far: boolean,
    body?: Path,
  ): Point => {
    const a0 = ar.a + lean * 0.5;
    const e: Point = [shJ[0] + Math.sin(a0) * U, shJ[1] + Math.cos(a0) * U];
    const fd: Point = [Math.sin(a0 + ar.el), Math.cos(a0 + ar.el)];
    const hd: Point = [e[0] + fd[0] * F, e[1] + fd[1] * F];
    const sleeve = far ? mix(L.top, -0.22) : L.top;
    const sk = far ? mix(skin, -0.18) : skin;
    const bare = L.sleeve === "short" || L.sleeve === "rolled";
    const m = L.sleeve === "short" ? 0.5 : 0.88;
    const end: Point = [
      shJ[0] + (e[0] - shJ[0]) * m,
      shJ[1] + (e[1] - shJ[1]) * m,
    ];
    const segs: Seg[] = [
      {
        p: ell(
          hd[0] + fd[0] * 0.95,
          hd[1] + fd[1] * 0.95,
          1.4,
          1.65,
          -(a0 + ar.el),
        ),
        c: sk,
      },
      {
        p: capsule(e[0], e[1], hd[0], hd[1], 1.8 * w, 1.3 * w),
        c: bare ? sk : sleeve,
      },
      {
        p: capsule(shJ[0], shJ[1], e[0], e[1], 2.35 * w, 1.85 * w),
        c: bare ? sk : sleeve,
      },
    ];
    if (bare)
      segs.push({
        p: capsule(shJ[0], shJ[1], end[0], end[1], 2.45 * w, 2.2 * w),
        c: sleeve,
      });
    limb(
      g,
      segs,
      body
        ? {
            off: 0.7,
            merge: { at: shJ, r: 3.6 * w, body },
            lit: [ell(shJ[0], shJ[1] - 0.4, 2.6 * w, 2.4 * w)],
          }
        : { off: 0.7 },
    );
    const up = unit(shJ, e);
    const fo = unit(e, hd);
    crease(g, e, shJ, hd, 1.8 * w, ar.el);
    if (bare) seam(g, end, up, 2.2 * w, 0.32);
    else {
      seam(g, hd, fo, 1.3 * w, 0.3);
      softLine(
        g,
        [
          shJ[0] + up[0] * 2.5 + up[1] * 1.2,
          shJ[1] + up[1] * 2.5 - up[0] * 1.2,
        ],
        [e[0] - up[0] * 2, e[1] - up[1] * 2 + 0.3],
        [e[0] - up[0] * 0.6 - up[1] * 1, e[1] - up[1] * 0.6 + up[0] * 1],
        0.13,
      );
    }
    return hd;
  };
  const [arm0, arm1] = G.arms;
  const [leg0, leg1] = legPts;
  if (!arm0 || !arm1 || !leg0 || !leg1)
    throw new Error("characters: a gait has two arms and two legs");
  // far side first (darker), then near
  drawArm(arm1, true);
  drawLeg(leg1, true, null);
  drawLeg(
    leg0,
    false,
    !L.coat && !L.skirt
      ? smooth([
          [bx(0.1, -2.7 * w), by(0.1)],
          [bx(0.1, 2.5 * w), by(0.1)],
          [hip[0] + 2.4 * w, hip[1] + 1.4],
          [hip[0] - 2.6 * w, hip[1] + 1.4],
        ])
      : null,
  );
  if (L.skirt) {
    // the skirt swings behind the walk, with lag
    const hem = hip[1] + 13 * h;
    const sw2 = G.lag * 1.2;
    part(
      g,
      smooth([
        [hip[0] - 3.4 * w, hip[1] - 1],
        [hip[0] + 3.2 * w, hip[1] - 1],
        [hip[0] + 5.6 * w + sw2, hem],
        [hip[0] + 0.5 + sw2 * 0.5, hem + 0.8],
        [hip[0] - 5.2 * w + sw2, hem],
      ]),
      L.skirt,
      { off: 1.2 },
    );
  }
  // torso: a tapered body from shoulders to hip, chest forward
  const coatLen = L.coat ? 7.5 * h : 1.6;
  const body: Point[] = [
    [bx(1, -2.8 * w), by(1) - 0.4],
    [bx(1, 2.2 * w), by(1) + 0.2],
    [bx(0.62, 3.5 * w), by(0.62)],
    [bx(0.18, 2.9 * w), by(0.18)],
    [bx(0, 3.0 * w + G.lag * 0.3), hip[1] + coatLen],
    [bx(0, -3.2 * w + G.lag * 0.3), hip[1] + coatLen],
    [bx(0.35, -3.4 * w), by(0.35)],
    [bx(0.8, -3.4 * w), by(0.8)],
  ];
  const torsoP = smooth(body);
  part(g, torsoP, L.top, { off: 1.3 });
  if (L.coat) {
    g.strokeStyle = "rgba(44,32,24,.45)";
    g.lineWidth = 0.5;
    g.beginPath();
    g.moveTo(bx(0.7, 2.6 * w), by(0.7));
    g.lineTo(bx(0, 2.3 * w + G.lag * 0.3), hip[1] + coatLen - 0.5);
    g.stroke();
    g.fillStyle = "rgba(44,32,24,.6)";
    for (const k of [0.55, 0.3]) {
      g.beginPath();
      g.arc(bx(k, 2.2 * w), by(k), 0.35, 0, TAU);
      g.fill();
    }
  }
  if (L.apron)
    part(
      g,
      smooth([
        [bx(0.75, 2.6 * w), by(0.75)],
        [bx(0.3, 3.2 * w), by(0.3)],
        [hip[0] + 3.4 * w + G.lag * 0.4, hip[1] + 8 * h],
        [hip[0] + 1.4 * w + G.lag * 0.4, hip[1] + 8.4 * h],
        [bx(0.4, 1.4 * w), by(0.4)],
      ]),
      L.apron,
      { off: 0.8 },
    );
  if (L.shawl)
    part(
      g,
      smooth([
        [bx(1, -2.6 * w), by(1) - 0.6],
        [bx(1, 2.4 * w), by(1)],
        [bx(0.55, 3.4 * w), by(0.55) + G.lag * 0.2],
        [bx(0.5, -0.5), by(0.38) + 1 + G.lag * 0.3],
        [bx(0.55, -3.4 * w), by(0.55)],
      ]),
      L.shawl,
      { off: 1 },
    );
  if (L.satchel) {
    g.strokeStyle = mix(L.satchel, -0.3);
    g.lineWidth = 0.9;
    g.beginPath();
    g.moveTo(bx(1, 1.2), by(1));
    g.lineTo(bx(0.05, -3.2 * w), by(0.05));
    g.stroke();
    part(
      g,
      smooth([
        [hip[0] - 4.8 * w, hip[1] - 2.6],
        [hip[0] - 1.2 * w, hip[1] - 2.8],
        [hip[0] - 1.0 * w + G.lag * 0.4, hip[1] + 2.6],
        [hip[0] - 4.9 * w + G.lag * 0.4, hip[1] + 2.4],
      ]),
      L.satchel,
      { off: 0.6 },
    );
  }
  // neck and head
  limb(
    g,
    [
      {
        p: capsule(
          nk[0],
          nk[1] + 1.4,
          nk[0] + 0.3,
          nk[1] - 1.2,
          1.3 * w,
          1.15 * w,
        ),
        c: mix(skin, -0.08),
      },
    ],
    {
      off: 0.4,
      merge: { at: [nk[0], nk[1] + 1.4], r: 2.6, body: torsoP },
      lit: [torsoP],
    },
  );
  sideHead(g, L, head, hr, hy, G, pose);
  const hd = drawArm(arm0, false, torsoP);
  if (L.basket) basket(g, hd[0] - 1, hd[1] + 1.2, G.lag);
  if (L.cane) {
    const tip: Point = [hd[0] + 2.2 + G.sway * 1.2, 0];
    g.strokeStyle = "#5a4330";
    g.lineWidth = 1.1;
    g.lineCap = "round";
    g.beginPath();
    g.moveTo(hd[0], hd[1] - 1.2);
    g.lineTo(tip[0], tip[1] - 0.2);
    g.stroke();
    g.strokeStyle = INK;
    g.lineWidth = 0.35;
    g.stroke();
    g.lineCap = "butt";
  }
}

function frontFigure(
  g: Ctx2D,
  L: Look,
  back: boolean,
  pose: FigurePose,
  G: Gait,
  d: Dims,
): void {
  const { h, w, T, S, U, F, torso, neck, hr, hy } = d;
  const skin = L.skin;
  const dirSign = back ? -1 : 1;
  const hipW = 2.9 * w;
  const shW = 4.9 * w;
  // swinging toward the viewer reads as a shorter leg, a lifted knee and a foot further down
  const legsFB = G.legs.map((l, i) => {
    const kx = (i ? 1 : -1) * hipW * 0.9;
    const ky = Math.cos(l.th) * T * 0.98;
    const kz = Math.sin(l.th) * T;
    const sa = l.th - l.kn * 0.5;
    const ax = kx * 1.02;
    const ay = ky + Math.cos(sa) * S * 0.98;
    const az = kz + Math.sin(sa) * S;
    return {
      kx,
      ky: ky + kz * 0.28 * dirSign,
      ax,
      ay: ay + az * 0.28 * dirSign,
      az,
    };
  });
  const ground = Math.max(...legsFB.map((l) => l.ay)) + 1.5;
  const hipY = -ground;
  const tilt = G.sway * 0.05;
  const hipP: Point = [0, hipY];
  const sh: Point = [Math.sin(L.lean * 0.3) * 0, hipY - torso];
  const nk: Point = [0, sh[1] - neck];
  const head: Point = [G.sway * 0.25, nk[1] - hy * 0.86];
  const hipAt = (i: number): Point => [
    hipP[0] + (i ? 1 : -1) * hipW,
    hipP[1] + (i ? 1 : -1) * tilt * hipW,
  ];
  const shAt = (i: number): Point => [
    (i ? 1 : -1) * shW,
    sh[1] - (i ? 1 : -1) * tilt * shW * 0.8 + 1,
  ];
  // both legs (and the seat of the trousers) are ONE shape under one outline: no ring at the hips, knees or ankles
  const legSegs = (i: number) => {
    const l = legsFB[i];
    if (!l) throw new Error("characters: a gait has two legs");
    const hp = hipAt(i);
    const k: Point = [hp[0] + (l.kx - (i ? 1 : -1) * hipW) * 0.3, hp[1] + l.ky];
    const a: Point = [hp[0] + (l.ax - (i ? 1 : -1) * hipW) * 0.3, hp[1] + l.ay];
    const near = l.az * dirSign > 0;
    const col = near ? L.bottom : mix(L.bottom, -0.1);
    const shoe: Seg = {
      p: back
        ? ell(a[0], a[1] + 0.6, 1.95, 1.55)
        : smooth([
            [a[0] - 1.8, a[1] - 0.4],
            [a[0] + 1.8, a[1] - 0.4],
            [a[0] + 2.05, a[1] + 1.9],
            [a[0] - 2.05, a[1] + 1.9],
          ]),
      c: L.shoe,
    };
    const legs: Seg[] = [
      { p: capsule(hp[0], hp[1], k[0], k[1], 2.75 * w, 2.05 * w), c: col },
      { p: capsule(k[0], k[1], a[0], a[1], 2.05 * w, 1.5 * w), c: col },
    ];
    return { k, a, hp, shoe, legs };
  };
  const drawLegsFB = () => {
    const l0 = legSegs(0);
    const l1 = legSegs(1);
    const ls = [l0, l1];
    const segs: Seg[] = [l0.shoe, l1.shoe, ...l0.legs, ...l1.legs];
    if (!L.skirt && !L.coat)
      segs.push({
        p: smooth([
          [-hipW - 1.4, hipY - 2.4],
          [hipW + 1.4, hipY - 2.4],
          [hipW + 1.6, hipY + 1.8],
          [0, hipY + 2.6],
          [-hipW - 1.6, hipY + 1.8],
        ]),
        c: L.bottom,
      });
    limb(g, segs, { off: 0.75 });
    ls.forEach(({ k, a, hp }, i) => {
      const dd = unit(k, a);
      const side = i ? 1 : -1;
      seam(g, [a[0] - dd[0] * 0.4, a[1] - dd[1] * 0.4], dd, 1.5 * w, 0.24);
      softLine(
        g,
        [hp[0] - side * 1.2, hp[1] + 2.5],
        [k[0] - side * 0.2, (hp[1] + k[1]) / 2 + 1.5],
        [k[0] + side * 0.6, k[1] - 0.6],
        0.13,
      );
    });
  };
  // an arm is ONE shape (hand, forearm, upper arm, sleeve), growing out of the torso at the shoulder
  const drawArmFB = (i: number, body: Path): Point => {
    const ar = G.arms[i];
    if (!ar) throw new Error("characters: a gait has two arms");
    const s0 = shAt(i);
    const side = i ? 1 : -1;
    const z = Math.sin(ar.a) * U * dirSign; // + toward viewer
    const e: Point = [
      s0[0] + side * (0.6 + Math.abs(ar.a) * 0.4),
      s0[1] + Math.cos(ar.a) * U * 0.95 + z * 0.3,
    ];
    const fz = Math.sin(ar.a + ar.el) * F * dirSign;
    const hd: Point = [
      e[0] - side * 0.3 * (1 + ar.el),
      e[1] + Math.cos(ar.a + ar.el) * F * 0.95 + fz * 0.3,
    ];
    const bare = L.sleeve === "short" || L.sleeve === "rolled";
    const m = L.sleeve === "short" ? 0.5 : 0.88;
    const rt: Point = [s0[0] - side * 0.35, s0[1] + 0.8]; // the arm's root sits inside the shoulder: a rounded deltoid
    const end: Point = [rt[0] + (e[0] - rt[0]) * m, rt[1] + (e[1] - rt[1]) * m];
    const segs: Seg[] = [
      { p: ell(hd[0], hd[1] + 1, 1.4, 1.75), c: skin },
      {
        p: capsule(e[0], e[1], hd[0], hd[1], 1.8 * w, 1.3 * w),
        c: bare ? skin : L.top,
      },
      {
        p: capsule(rt[0], rt[1], e[0], e[1], 2.2 * w, 1.8 * w),
        c: bare ? skin : L.top,
      },
    ];
    if (bare)
      segs.push({
        p: capsule(rt[0], rt[1], end[0], end[1], 2.3 * w, 2.15 * w),
        c: L.top,
      });
    limb(g, segs, {
      off: 0.7,
      merge: { at: rt, r: 3.6 * w, body },
      lit: [ell(rt[0], rt[1] - 0.3, 2.5 * w, 2.4 * w)],
    });
    if (bare) seam(g, end, unit(rt, e), 2.15 * w, 0.32);
    else seam(g, hd, unit(e, hd), 1.3 * w, 0.3);
    crease(g, e, rt, hd, 1.8 * w, ar.el * 0.7);
    return hd;
  };
  drawLegsFB();
  if (L.skirt) {
    const hem = hipY + 13 * h;
    part(
      g,
      smooth([
        [-3.6 * w, hipY - 1],
        [3.6 * w, hipY - 1],
        [5.6 * w + G.lag * 0.4, hem + G.lag * 0.3],
        [0, hem + 1],
        [-5.6 * w + G.lag * 0.4, hem - G.lag * 0.3],
      ]),
      L.skirt,
      { off: 1.2 },
    );
  }
  const coatLen = L.coat ? 7.5 * h : 0.6;
  const s0 = shAt(0);
  const s1 = shAt(1);
  const bodyFB: Point[] = [
    [s0[0] - 0.4, s0[1] - 0.6],
    [-1.2, sh[1] - 1.2],
    [1.2, sh[1] - 1.2],
    [s1[0] + 0.4, s1[1] - 0.6],
    [s1[0] + 0.2, s1[1] + 4],
    [hipW + 1.4, hipY - 2],
    [hipW + 2.2 + (L.coat ? 0.8 : 0), hipY + coatLen],
    [-hipW - 2.2 - (L.coat ? 0.8 : 0), hipY + coatLen],
    [-hipW - 1.4, hipY - 2],
    [s0[0] - 0.2, s0[1] + 4],
  ];
  const torsoP = smooth(bodyFB);
  part(g, torsoP, L.top, { off: 1.4 });
  if (!back) {
    if (L.coat) {
      g.strokeStyle = "rgba(44,32,24,.5)";
      g.lineWidth = 0.5;
      g.beginPath();
      g.moveTo(0.3, sh[1] + 0.5);
      g.lineTo(0.6, hipY + coatLen - 0.4);
      g.stroke();
      g.fillStyle = "rgba(44,32,24,.6)";
      for (const k of [0.3, 0.55, 0.8]) {
        g.beginPath();
        g.arc(-0.6, sh[1] + (hipY - sh[1]) * k, 0.33, 0, TAU);
        g.fill();
      }
    } else if (!L.apron) {
      g.strokeStyle = "rgba(44,32,24,.35)";
      g.lineWidth = 0.45;
      g.beginPath();
      g.moveTo(-1.4, sh[1] - 0.6);
      g.quadraticCurveTo(0, sh[1] + 1.4, 1.4, sh[1] - 0.6);
      g.stroke();
    }
    if (L.apron) {
      g.strokeStyle = mix(L.apron, -0.35);
      g.lineWidth = 0.7;
      g.beginPath();
      g.moveTo(-2.1 * w, sh[1] + 2.6);
      g.lineTo(s0[0] + 1.2, s0[1] - 0.4);
      g.moveTo(2.1 * w, sh[1] + 2.6);
      g.lineTo(s1[0] - 1.2, s1[1] - 0.4);
      g.stroke();
      part(
        g,
        poly([
          [-2.3 * w, sh[1] + 2.4],
          [2.3 * w, sh[1] + 2.4],
          [2.5 * w, hipY - 2.4],
          [3.4 * w, hipY - 1.6],
          [3.5 * w + G.lag * 0.2, hipY + 8 * h],
          [-3.5 * w + G.lag * 0.2, hipY + 8 * h],
          [-3.4 * w, hipY - 1.6],
          [-2.5 * w, hipY - 2.4],
        ]),
        L.apron,
        { off: 0.9 },
      );
      g.strokeStyle = "rgba(30,20,10,.35)";
      g.lineWidth = 0.4;
      g.beginPath();
      g.moveTo(-1.6 * w, hipY + 1);
      g.lineTo(1.6 * w, hipY + 1);
      g.lineTo(1.6 * w, hipY + 4);
      g.lineTo(-1.6 * w, hipY + 4);
      g.closePath();
      g.stroke();
    }
    if (L.satchel) {
      g.strokeStyle = mix(L.satchel, -0.3);
      g.lineWidth = 0.95;
      g.beginPath();
      g.moveTo(s0[0] + 1, s0[1] - 0.4);
      g.lineTo(hipW + 1.4, hipY - 1);
      g.stroke();
    }
  } else if (L.satchel) {
    g.strokeStyle = mix(L.satchel, -0.3);
    g.lineWidth = 0.95;
    g.beginPath();
    g.moveTo(s1[0] - 1, s1[1] - 0.4);
    g.lineTo(-hipW - 1.4, hipY - 1);
    g.stroke();
  }
  if (L.satchel) {
    const pts: Point[] = (
      [
        [hipW + 0.4, hipY - 2.8],
        [hipW + 4.2, hipY - 2.6],
        [hipW + 4.3, hipY + 2.4],
        [hipW + 0.5, hipY + 2.2],
      ] as const
    ).map(([x, y]): Point => [back ? -x : x, y]);
    part(g, smooth(pts), L.satchel, { off: 0.6 });
  }
  if (L.shawl)
    part(
      g,
      smooth([
        [s0[0] - 0.8, s0[1] - 0.6],
        [0, sh[1] - 1.8],
        [s1[0] + 0.8, s1[1] - 0.6],
        [s1[0] + 0.6, s1[1] + 4.5],
        [0, sh[1] + (back ? 7.5 : 5.5) + G.lag * 0.3],
        [s0[0] - 0.6, s0[1] + 4.5],
      ]),
      L.shawl,
      { off: 1 },
    );
  drawArmFB(0, torsoP);
  const h1 = drawArmFB(1, torsoP);
  limb(
    g,
    [
      {
        p: capsule(nk[0], nk[1] + 1.6, nk[0], nk[1] - 1.2, 1.35 * w, 1.2 * w),
        c: mix(skin, -0.1),
      },
    ],
    {
      off: 0.4,
      merge: { at: [nk[0], nk[1] + 1.6], r: 2.6, body: torsoP },
      lit: [torsoP],
    },
  );
  frontHead(g, L, head, hr, hy, G, pose, back);
  if (!back) {
    if (L.basket) basket(g, h1[0] + 0.6, h1[1] + 1.8, G.lag);
    if (L.cane) {
      g.strokeStyle = "#5a4330";
      g.lineWidth = 1.1;
      g.lineCap = "round";
      g.beginPath();
      g.moveTo(h1[0], h1[1]);
      g.lineTo(h1[0] + 1.2, -0.2);
      g.stroke();
      g.strokeStyle = INK;
      g.lineWidth = 0.35;
      g.stroke();
      g.lineCap = "butt";
    }
  } else if (L.basket) basket(g, -shW - 1.2, hipY - 1, G.lag);
}
