// Places' building on Isle: the cartographer's lighthouse — a tapering stone
// tower on slate rocks with a verdigris cap, a map table and a compass rose at
// its foot; at dusk and night its two beams sweep the sea.

import {
  accent,
  bbox,
  castShadow,
  doorArch,
  grain,
  hline,
  ink,
  jit,
  mix,
  planks,
  poly,
  shrub,
  spill,
  steps,
  tufts,
  wash,
  windowRect,
  type Box,
  type BuildingSpec,
  type Ctx2D,
  type Pt,
  type Rnd,
} from "@plugins/apps/plugins/isle/plugins/buildings/core";

const GRAIN_BOX: Box = [-280, -330, 280, 50];
const TOWER_TOP = -226;

/** A faceted slate boulder centred on (x, y), `s` its radius. */
function rockLump(g: Ctx2D, x: number, y: number, s: number, rnd: Rnd): void {
  const pts: Pt[] = [];
  const n = 7;
  for (let i = 0; i < n; i++) {
    const a = Math.PI + (i / (n - 1)) * Math.PI;
    pts.push([
      x + Math.cos(a) * s * (0.8 + rnd() * 0.35),
      y + Math.sin(a) * s * (0.62 + rnd() * 0.3),
    ]);
  }
  pts.push([x + s * 0.9, y + s * 0.15], [x - s * 0.9, y + s * 0.15]);
  castShadow(
    g,
    [
      [x - s * 0.8, y + s * 0.1],
      [x + s, y + s * 0.1],
      [x + s * 1.2, y + s * 0.4],
      [x - s * 0.5, y + s * 0.4],
    ],
    0.32,
  );
  wash(g, () => poly(g, pts), bbox(pts), "#868b92", rnd, {
    blob: s * 0.4,
    var: 22,
    shadeA: 0.35,
  });
  const P = (i: number) => pts[i]!;
  // facets: a lit top plane and a dark right plane
  g.fillStyle = "rgba(220,226,232,.35)";
  poly(g, [
    P(1),
    P(2),
    P(3),
    [x - s * 0.1, y - s * 0.15],
    [x - s * 0.55, y - s * 0.05],
  ]);
  g.fill();
  g.fillStyle = "rgba(30,34,40,.25)";
  poly(g, [
    P(4),
    P(5),
    P(6),
    [x + s * 0.9, y + s * 0.15],
    [x + s * 0.2, y + s * 0.1],
  ]);
  g.fill();
  ink(g, 0.8, 0.45);
  hline(g, x - s * 0.1, y - s * 0.15, P(4)[0], P(4)[1], rnd);
  hline(g, x - s * 0.1, y - s * 0.15, x + s * 0.2, y + s * 0.12, rnd);
}

export const lighthouse: BuildingSpec = {
  footprint: {
    w: 150,
    depth: 84,
    ground: [-129, -112, 158, 46],
    upper: [-48, -315, 48, -112],
  },
  setting: ["coast", "cape"],
  signX: -112,
  lights: [
    [0, -258, 26],
    [0, -24, 12],
    [0, -150, 8],
  ],
  paint(g, s) {
    const r = s.rnd;
    const A = accent(s.hue);
    castShadow(
      g,
      [
        [-30, 4],
        [40, 4],
        [150, 34],
        [70, -20],
      ],
      0.28,
    );
    // rocks the tower stands on
    for (const [x, y, sz] of [
      [-70, -20, 22],
      [74, -22, 24],
      [-96, 2, 22],
      [96, 0, 24],
      [-62, 8, 28],
      [58, 8, 30],
      [-34, 18, 20],
      [34, 20, 18],
      [-108, 22, 16],
      [104, 24, 18],
    ] as const)
      rockLump(g, x, y, sz, r);
    // tapering stone tower, coursed in curved rows, lit from the left
    const yb = -6;
    const yt = TOWER_TOP;
    const rb = 40;
    const rt = 29;
    const rx = (y: number) => rb + ((rt - rb) * (y - yb)) / (yt - yb);
    const body = () => {
      g.beginPath();
      g.moveTo(-rb, yb);
      g.lineTo(-rt, yt);
      g.lineTo(rt, yt);
      g.lineTo(rb, yb);
      g.ellipse(0, yb, rb, 9, 0, 0, Math.PI);
      g.closePath();
    };
    g.save();
    body();
    g.clip();
    const gr = g.createLinearGradient(-rb, 0, rb, 0);
    gr.addColorStop(0, "#d2cbbb");
    gr.addColorStop(0.45, "#b9b2a1");
    gr.addColorStop(1, "#7c7568");
    g.fillStyle = gr;
    g.fillRect(-rb, yt, 2 * rb, yb - yt + 10);
    for (let y = yb; y > yt; y -= 9) {
      const R = rx(y);
      ink(g, 0.7, 0.4);
      g.beginPath();
      g.ellipse(0, y, R, 6, 0, 0.1, Math.PI - 0.1);
      g.stroke();
      for (let a = (y / 9) % 2 ? 0.25 : 0; a < Math.PI; a += 0.5) {
        const x = -Math.cos(a) * R;
        hline(g, x, y + Math.sin(a) * 6, x, y + Math.sin(a) * 6 - 9, r, 0.2);
      }
      for (let k = 0; k < 6; k++) {
        g.fillStyle = jit("#b4ad9c", r, 40, 0.25);
        g.beginPath();
        g.ellipse(-R + r() * 2 * R, y - 4, 4 + r() * 4, 3, 0, 0, 7);
        g.fill();
      }
    }
    // weathering streaks
    for (let k = 0; k < 10; k++) {
      g.strokeStyle = "rgba(70,64,52,.16)";
      g.lineWidth = 2 + r() * 3;
      const x = -rb + r() * 2 * rb;
      g.beginPath();
      g.moveTo(x, yt + 10 + r() * 60);
      g.lineTo(x + (r() - 0.5) * 3, yt + 70 + r() * 120);
      g.stroke();
    }
    g.restore();
    body();
    ink(g, 1.5);
    g.stroke();
    // a band in the accent colour (faded paint) and slit windows
    g.save();
    body();
    g.clip();
    g.fillStyle = mix(A, "#b9b2a1", 0.35, 0.75);
    g.fillRect(-rb, -150, 2 * rb, 14);
    g.fillStyle = "rgba(30,26,20,.2)";
    g.fillRect(-rb, -137, 2 * rb, 2);
    g.restore();
    for (const [wx, wy] of [
      [-4, -110],
      [4, -180],
    ] as const)
      windowRect(g, wx - 5, wy, 10, 18, r, {
        arch: true,
        lit: s.night,
        sill: "#a49d8c",
      });
    // gallery and lantern room
    g.fillStyle = "#5c5a56";
    g.beginPath();
    g.ellipse(0, yt, 44, 11, 0, 0, 7);
    g.fill();
    ink(g, 1.3);
    g.stroke();
    g.fillStyle = "#47443f";
    g.fillRect(-44, yt, 88, 5);
    ink(g, 1);
    g.strokeRect(-44, yt, 88, 5);
    const lr = 22;
    const ly0 = yt - 4;
    const ly1 = yt - 38;
    const glass = g.createLinearGradient(-lr, 0, lr, 0);
    glass.addColorStop(0, s.night ? "#fff3c4" : "#c9dde2");
    glass.addColorStop(1, s.night ? "#f2c25e" : "#7e9aa3");
    g.fillStyle = glass;
    g.fillRect(-lr, ly1, 2 * lr, ly0 - ly1);
    g.fillStyle = "#3f3c38";
    for (let k = -2; k <= 2; k++) g.fillRect(k * 10 - 1, ly1, 2, ly0 - ly1);
    ink(g, 1.3);
    g.strokeRect(-lr, ly1, 2 * lr, ly0 - ly1);
    if (!s.night) {
      g.fillStyle = "#e9dca6";
      g.beginPath();
      g.ellipse(0, (ly0 + ly1) / 2, 7, 10, 0, 0, 7);
      g.fill();
      ink(g, 0.8, 0.6);
      g.stroke();
    }
    // railing
    ink(g, 1.1);
    g.beginPath();
    g.ellipse(0, yt - 12, 46, 11, 0, 0, Math.PI);
    g.stroke();
    for (let a = 0.15; a < Math.PI; a += 0.28) {
      const x = Math.cos(a) * 46;
      const y = yt - 12 + Math.sin(a) * 11;
      hline(g, x, y, x, y + 11, r, 0.2);
    }
    // copper cap, verdigris
    wash(
      g,
      () => {
        g.beginPath();
        g.moveTo(-lr - 5, ly1);
        g.quadraticCurveTo(-lr + 2, ly1 - 26, 0, ly1 - 32);
        g.quadraticCurveTo(lr - 2, ly1 - 26, lr + 5, ly1);
        g.closePath();
      },
      [-lr - 5, ly1 - 32, lr + 5, ly1],
      "#6f9586",
      r,
      { blob: 5, var: 26, shadeA: 0.35 },
    );
    g.fillStyle = "#8a6a3e";
    g.fillRect(-lr - 6, ly1 - 1, 2 * lr + 12, 3);
    ink(g, 1);
    hline(g, 0, ly1 - 32, 0, ly1 - 46, r);
    g.fillStyle = "#8a6a3e";
    g.beginPath();
    g.arc(0, ly1 - 47, 2.5, 0, 7);
    g.fill();
    // door
    doorArch(g, 0, 0, 20, 34, r, { col: A });
    steps(g, 0, 3, 24, 2, r);
    // map table with a weighted chart, compass rose on a flagstone
    const tx = 50;
    const ty = 30;
    castShadow(
      g,
      [
        [tx - 16, ty],
        [tx + 16, ty],
        [tx + 24, ty + 5],
        [tx - 8, ty + 5],
      ],
      0.3,
    );
    g.fillStyle = "#5a4632";
    g.fillRect(tx - 14, ty - 14, 3, 14);
    g.fillRect(tx + 11, ty - 14, 3, 14);
    planks(g, tx - 18, ty - 20, tx + 18, ty - 14, r, {
      base: "#7d6648",
      vertical: false,
      pw: 6,
    });
    const map: Pt[] = [
      [tx - 15, ty - 21],
      [tx + 14, ty - 22],
      [tx + 16, ty - 15],
      [tx - 13, ty - 14],
    ];
    wash(g, () => poly(g, map), bbox(map), "#e4d6b0", r, {
      blob: 3,
      var: 14,
      lw: 0.9,
    });
    ink(g, 0.7, 0.7);
    hline(g, tx - 10, ty - 17, tx - 2, ty - 20, r);
    hline(g, tx - 2, ty - 20, tx + 4, ty - 16, r);
    hline(g, tx + 4, ty - 16, tx + 11, ty - 19, r);
    g.fillStyle = "#7a5a3a";
    g.beginPath();
    g.arc(tx + 12, ty - 20, 1.6, 0, 7);
    g.fill();
    g.fillStyle = A;
    g.beginPath();
    g.arc(tx - 3, ty - 19.5, 1.5, 0, 7);
    g.fill();
    const cx = -46;
    const cy = 32;
    g.fillStyle = "#a59e8c";
    g.beginPath();
    g.ellipse(cx, cy, 16, 7, 0, 0, 7);
    g.fill();
    ink(g, 1);
    g.stroke();
    g.fillStyle = "#a8874f";
    poly(g, [
      [cx, cy - 6],
      [cx + 3, cy],
      [cx, cy + 6],
      [cx - 3, cy],
    ]);
    g.fill();
    poly(g, [
      [cx - 12, cy],
      [cx, cy - 1.5],
      [cx + 12, cy],
      [cx, cy + 1.5],
    ]);
    g.fill();
    ink(g, 0.7, 0.8);
    g.stroke();
    tufts(g, -40, 40, 2, r, 10);
    for (const [x, y, z, k] of [
      [-104, 0, 13, 1],
      [100, -2, 12, 0],
      [-20, 40, 8, 2],
    ] as const)
      shrub(g, x, y, z, r, k);
    grain(g, GRAIN_BOX, r);
  },
  animate(g, s) {
    // the two beams sweeping the sea: light (`lighter`), never part of the footprint
    if (s.dusk || s.night) {
      const a = s.t * 0.7;
      const y = TOWER_TOP - 21;
      g.save();
      g.globalCompositeOperation = "lighter";
      for (const b of [a, a + Math.PI]) {
        const facing = 0.5 + 0.5 * Math.sin(b);
        const L = 250;
        const gr = g.createRadialGradient(0, y, 4, 0, y, L);
        gr.addColorStop(0, `rgba(255,240,190,${0.32 + 0.25 * facing})`);
        gr.addColorStop(1, "rgba(255,240,190,0)");
        g.fillStyle = gr;
        g.beginPath();
        g.moveTo(0, y);
        g.lineTo(Math.cos(b - 0.12) * L, y + Math.sin(b - 0.12) * L * 0.45);
        g.lineTo(Math.cos(b + 0.12) * L, y + Math.sin(b + 0.12) * L * 0.45);
        g.closePath();
        g.fill();
      }
      g.restore();
    }
    if (s.open) spill(g, 22, 0.45);
  },
};
