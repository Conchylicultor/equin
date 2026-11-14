// Heads: eyes, the front/back head and the side head, each with its hair style.

import type { Ctx2D } from "@plugins/apps/plugins/isle/plugins/buildings/core";
import { mix } from "./colour";
import { ell, part, smooth, TAU, type Point } from "./draw-parts";
import type { FigurePose, Gait } from "./gait";
import type { Look } from "./looks";

function eyes(
  g: Ctx2D,
  pts: readonly Point[],
  pose: FigurePose,
  back: boolean,
): void {
  if (back) return;
  const blink = pose.blink;
  const gz = pose.gaze;
  for (const [x, y] of pts) {
    if (blink) {
      g.strokeStyle = "rgba(40,28,20,.9)";
      g.lineWidth = 0.45;
      g.beginPath();
      g.moveTo(x - 0.6, y + 0.1);
      g.quadraticCurveTo(x, y + 0.45, x + 0.6, y + 0.1);
      g.stroke();
      continue;
    }
    g.fillStyle = "#f4ece0";
    g.beginPath();
    g.ellipse(x, y, 0.62, 0.55, 0, 0, TAU);
    g.fill();
    g.fillStyle = "#2a1d16";
    g.beginPath();
    g.ellipse(x + gz * 0.25, y + 0.05, 0.38, 0.5, 0, 0, TAU);
    g.fill();
    g.fillStyle = "rgba(255,255,255,.8)";
    g.beginPath();
    g.arc(x + gz * 0.25 - 0.12, y - 0.15, 0.1, 0, TAU);
    g.fill();
    g.strokeStyle = "rgba(40,28,20,.85)";
    g.lineWidth = 0.35;
    g.beginPath();
    g.moveTo(x - 0.7, y - 0.4);
    g.quadraticCurveTo(x, y - 0.75, x + 0.7, y - 0.45);
    g.stroke();
  }
}

export function frontHead(
  g: Ctx2D,
  L: Look,
  c: Point,
  hr: number,
  hy: number,
  G: Gait,
  pose: FigurePose,
  back: boolean,
): void {
  const [x, y] = c;
  const lagY = G.hairLag * 0.3;
  // hair behind the head
  if (L.hairStyle === "bun" && back)
    part(g, ell(x, y - 2.2, 2.2, 1.9), L.hair, { off: 0.6 });
  if (L.hairStyle === "curly")
    part(
      g,
      smooth([
        [x - hr - 1.1, y + 0.8],
        [x - hr - 0.8, y - hy + 0.4 + lagY],
        [x, y - hy - 1.6 + lagY],
        [x + hr + 0.8, y - hy + 0.4 + lagY],
        [x + hr + 1.1, y + 0.8],
        [x, y + (back ? 3.4 : 0.4)],
      ]),
      L.hair,
      { off: 0.9 },
    );
  // ears + face
  if (!back)
    for (const s of [-1, 1])
      part(g, ell(x + s * (hr - 0.1), y + 0.6, 0.8, 1.15), mix(L.skin, -0.06), {
        off: 0.3,
        lw: 0.5,
      });
  const face = smooth([
    [x - hr, y - 0.8],
    [x - hr * 0.95, y - hy * 0.85],
    [x, y - hy],
    [x + hr * 0.95, y - hy * 0.85],
    [x + hr, y - 0.8],
    [x + hr * 0.75, y + hy * 0.7],
    [x, y + hy * 0.98],
    [x - hr * 0.75, y + hy * 0.7],
  ]);
  part(g, face, L.skin, { off: 0.9, shade: 0.22 });
  if (!back) {
    eyes(
      g,
      [
        [x - 1.45, y + 0.15],
        [x + 1.45, y + 0.15],
      ],
      pose,
      back,
    );
    g.strokeStyle = "rgba(120,70,50,.6)";
    g.lineWidth = 0.4;
    g.beginPath();
    g.moveTo(x + 0.2, y + 0.6);
    g.quadraticCurveTo(x + 0.6, y + 1.7, x - 0.1, y + 1.9);
    g.stroke();
    g.strokeStyle = "rgba(90,40,30,.75)";
    g.lineWidth = 0.45;
    g.beginPath();
    g.moveTo(x - 0.8, y + 2.85);
    g.quadraticCurveTo(x, y + 3.15, x + 0.8, y + 2.8);
    g.stroke();
    g.fillStyle = "rgba(220,110,90,.18)";
    for (const s of [-1, 1]) {
      g.beginPath();
      g.ellipse(x + s * 2.2, y + 1.8, 0.9, 0.6, 0, 0, TAU);
      g.fill();
    }
    if (L.beard)
      part(
        g,
        smooth([
          [x - hr * 0.95, y + 0.4],
          [x - hr * 0.6, y + hy * 0.9 + 0.6],
          [x, y + hy + 1.4 + lagY],
          [x + hr * 0.6, y + hy * 0.9 + 0.6],
          [x + hr * 0.95, y + 0.4],
          [x + 1.2, y + 2.1],
          [x - 1.2, y + 2.1],
        ]),
        L.beard,
        { off: 0.6, shade: 0.2 },
      );
  }
  // hair on top
  const H = L.hair;
  if (L.hairStyle === "curly") {
    const pts: readonly Point[] = back
      ? [
          [-2.8, -2.8],
          [0, -3.6],
          [2.8, -2.8],
          [-3.4, -0.6],
          [3.4, -0.6],
          [-1.6, -0.5],
          [1.6, -0.6],
          [0, 1.2],
          [-2.6, 1.6],
          [2.6, 1.5],
        ]
      : [
          [-3, -2.6],
          [-1, -3.9],
          [1.2, -3.8],
          [3.1, -2.5],
          [-3.9, -0.6],
          [3.9, -0.7],
          [-2, -2.1],
          [0.2, -2.3],
          [2.1, -2],
        ];
    pts.forEach(([dx, dy], i) =>
      part(
        g,
        ell(
          x + (dx * hr) / 3.75,
          y + (dy * hy) / 4.4 - 0.4 + lagY * (1 + (i % 3) * 0.3),
          1.65,
          1.5,
        ),
        i % 2 ? H : mix(H, 0.08),
        { off: 0.6, lw: 0.55 },
      ),
    );
  } else if (L.hairStyle === "cap") {
    part(
      g,
      smooth([
        [x - hr - 0.4, y - 0.6],
        [x - hr * 0.9, y - hy * 0.9],
        [x, y - hy - 1],
        [x + hr * 0.9, y - hy * 0.9],
        [x + hr + 0.4, y - 0.6],
      ]),
      L.cap,
      { off: 0.8 },
    );
    if (!back)
      part(
        g,
        smooth([
          [x - hr - 0.2, y - 0.9],
          [x + hr + 0.2, y - 0.9],
          [x + hr * 0.7, y + 0.3],
          [x - hr * 0.7, y + 0.3],
        ]),
        mix(L.cap, -0.25),
        { off: 0.4 },
      );
    if (!back)
      for (const s of [-1, 1])
        part(g, ell(x + s * (hr - 0.4), y + 0.8, 0.9, 1.2), H, {
          off: 0.3,
          lw: 0.4,
        });
  } else if (L.hairStyle === "bun") {
    part(
      g,
      smooth([
        [x - hr - 0.3, y + 1.2],
        [x - hr * 0.9, y - hy * 0.95],
        [x, y - hy - 0.7],
        [x + hr * 0.9, y - hy * 0.95],
        [x + hr + 0.3, y + 1.2],
        [x + hr * 0.5, y - 1.9],
        [x, y - 2.6],
        [x - hr * 0.5, y - 1.9],
      ]),
      H,
      { off: 0.8 },
    );
    if (!back)
      part(g, ell(x + 0.4, y - hy - 1 + lagY, 2, 1.6), mix(H, -0.05), {
        off: 0.6,
      });
    g.strokeStyle = "rgba(40,20,10,.35)";
    g.lineWidth = 0.35;
    for (let i = -2; i <= 2; i++) {
      g.beginPath();
      g.moveTo(x + i * 0.8, y - hy + 0.2);
      g.quadraticCurveTo(x + i * 1.4, y - 2, x + i * 1.9, y);
      g.stroke();
    }
  } else if (L.hairStyle === "bald") {
    for (const s of [-1, 1])
      part(
        g,
        smooth([
          [x + s * (hr + 0.3), y + 1.4],
          [x + s * (hr + 0.5), y - 1.6],
          [x + s * (hr - 1.2), y - 2.6],
          [x + s * (hr - 1.6), y - 0.4],
        ]),
        H,
        { off: 0.4, lw: 0.5 },
      );
    if (back)
      part(
        g,
        smooth([
          [x - hr - 0.2, y + 1.2],
          [x - hr, y - 1.8],
          [x + hr, y - 1.8],
          [x + hr + 0.2, y + 1.2],
          [x, y + 2.6],
        ]),
        H,
        { off: 0.5 },
      );
    if (!back) {
      g.strokeStyle = "rgba(255,255,255,.55)";
      g.lineWidth = 0.55;
      g.beginPath();
      g.moveTo(x - 1.6, y - hy * 0.85);
      g.quadraticCurveTo(x - 0.4, y - hy - 0.1, x + 0.8, y - hy * 0.92);
      g.stroke();
    }
  } else {
    // short / swept
    const sweep = L.hairStyle === "swept" ? 1 : 0;
    part(
      g,
      smooth([
        [x - hr - 0.3, y + (back ? 2 : -0.2)],
        [x - hr * 0.95, y - hy * 0.95],
        [x - 0.5, y - hy - 1.2 + lagY * sweep],
        [x + hr * 0.9 + sweep, y - hy * 0.9 + lagY * sweep],
        [x + hr + 0.3, y + (back ? 2 : -0.2)],
        [x + hr * 0.6, y - 1.8 - sweep],
        [x - 0.6 * sweep, y - 2.4],
        [x - hr * 0.6, y - 1.6],
      ]),
      H,
      { off: 0.8 },
    );
    if (sweep) {
      g.strokeStyle = "rgba(60,40,20,.4)";
      g.lineWidth = 0.35;
      for (let i = 0; i < 4; i++) {
        g.beginPath();
        g.moveTo(x - 2.5 + i * 1.3, y - hy + 0.2);
        g.quadraticCurveTo(
          x - 1 + i * 1.4,
          y - hy - 0.6,
          x + 0.8 + i * 1.2,
          y - 2.2,
        );
        g.stroke();
      }
    }
  }
}

export function sideHead(
  g: Ctx2D,
  L: Look,
  c: Point,
  hr: number,
  hy: number,
  G: Gait,
  pose: FigurePose,
): void {
  const [x, y] = c;
  const lagY = G.hairLag * 0.3;
  const lagX = -Math.abs(G.hairLag) * 0.25;
  const H = L.hair;
  if (L.hairStyle === "curly")
    part(
      g,
      smooth([
        [x - hr - 1.2 + lagX, y + 1.5],
        [x - hr - 0.9 + lagX, y - hy + 0.5 + lagY],
        [x + 0.5, y - hy - 1.6 + lagY],
        [x + hr * 0.6, y - hy * 0.6],
        [x - 0.5, y + 1],
      ]),
      H,
      { off: 0.9 },
    );
  if (L.hairStyle === "bun")
    part(g, ell(x - hr - 0.8 + lagX, y - 2.2 + lagY, 2.1, 1.9), mix(H, -0.05), {
      off: 0.6,
    });
  // head profile: back of skull, brow, nose, lips, chin, jaw
  const head = smooth([
    [x - hr * 0.95, y + 0.8],
    [x - hr * 0.9, y - hy * 0.85],
    [x + 0.2, y - hy],
    [x + hr * 0.95, y - hy * 0.6],
    [x + hr + 0.2, y - 0.4],
    [x + hr + 1.2, y + 0.9],
    [x + hr + 0.15, y + 1.5],
    [x + hr + 0.35, y + 2.6],
    [x + hr * 0.6, y + hy * 0.95],
    [x - 0.6, y + hy * 0.7],
  ]);
  part(g, head, L.skin, { off: 0.9, shade: 0.22 });
  part(g, ell(x - 0.7, y + 0.6, 0.85, 1.2), mix(L.skin, -0.08), {
    off: 0.3,
    lw: 0.5,
  });
  eyes(g, [[x + hr * 0.62, y + 0.05]], pose, false);
  g.strokeStyle = "rgba(90,40,30,.7)";
  g.lineWidth = 0.4;
  g.beginPath();
  g.moveTo(x + hr + 0.15, y + 2.9);
  g.lineTo(x + hr - 0.6, y + 2.9);
  g.stroke();
  g.fillStyle = "rgba(220,110,90,.18)";
  g.beginPath();
  g.ellipse(x + hr * 0.45, y + 1.9, 0.9, 0.6, 0, 0, TAU);
  g.fill();
  if (L.beard)
    part(
      g,
      smooth([
        [x - 0.8, y + 0.6],
        [x + hr * 0.4, y + 2],
        [x + hr + 0.5, y + 2.4],
        [x + hr + 0.2, y + hy * 0.9],
        [x + hr * 0.4 + lagX, y + hy + 1.4 + lagY],
        [x - 0.9, y + hy * 0.6],
      ]),
      L.beard,
      { off: 0.6, shade: 0.2 },
    );
  if (L.hairStyle === "curly") {
    const pts: readonly Point[] = [
      [-3.2, -2.6],
      [-1.2, -3.9],
      [0.9, -3.7],
      [-3.9, -0.5],
      [-2.2, -1.6],
      [2.3, -2.9],
      [-3.4, 1.4],
    ];
    pts.forEach(([dx, dy], i) =>
      part(
        g,
        ell(
          x + (dx * hr) / 3.75 + lagX * (i % 2),
          y + (dy * hy) / 4.4 - 0.3 + lagY * (1 + (i % 3) * 0.3),
          1.65,
          1.5,
        ),
        i % 2 ? H : mix(H, 0.08),
        { off: 0.6, lw: 0.55 },
      ),
    );
  } else if (L.hairStyle === "cap") {
    part(
      g,
      smooth([
        [x - hr - 0.5, y - 0.2],
        [x - hr * 0.9, y - hy * 0.9],
        [x, y - hy - 1],
        [x + hr * 0.85, y - hy * 0.7],
        [x + hr * 0.7, y - 0.8],
      ]),
      L.cap,
      { off: 0.8 },
    );
    part(
      g,
      smooth([
        [x + hr * 0.5, y - 1.2],
        [x + hr + 2.6, y - 0.7],
        [x + hr + 2.4, y + 0.1],
        [x + hr * 0.5, y - 0.2],
      ]),
      mix(L.cap, -0.25),
      { off: 0.3 },
    );
    part(
      g,
      smooth([
        [x - hr - 0.3, y - 0.3],
        [x - 1, y - 0.3],
        [x - 0.8, y + 2.2],
        [x - hr - 0.2, y + 2],
      ]),
      H,
      { off: 0.3, lw: 0.4 },
    );
  } else if (L.hairStyle === "bun") {
    part(
      g,
      smooth([
        [x - hr - 0.4, y + 1.6],
        [x - hr * 0.9, y - hy * 0.95],
        [x + 0.6, y - hy - 0.7],
        [x + hr * 0.95, y - hy * 0.55],
        [x + hr * 0.5, y - 1.8],
        [x - 0.4, y - 1.4],
        [x - 1.4, y + 1.4],
      ]),
      H,
      { off: 0.8 },
    );
  } else if (L.hairStyle === "bald") {
    part(
      g,
      smooth([
        [x - hr - 0.3, y + 1.6],
        [x - hr - 0.5, y - 1.9],
        [x - 1.2, y - 2.5],
        [x - 0.8, y + 0.2],
        [x - 1.6, y + 2],
      ]),
      H,
      { off: 0.4, lw: 0.5 },
    );
    g.strokeStyle = "rgba(255,255,255,.5)";
    g.lineWidth = 0.5;
    g.beginPath();
    g.moveTo(x - 1.8, y - hy * 0.8);
    g.quadraticCurveTo(x, y - hy - 0.1, x + 1.6, y - hy * 0.75);
    g.stroke();
  } else {
    const sweep = L.hairStyle === "swept" ? 1 : 0;
    part(
      g,
      smooth([
        [x - hr - 0.4, y + 1.8],
        [x - hr * 0.95, y - hy * 0.95],
        [x + 0.2, y - hy - 1.1 + lagY * sweep],
        [x + hr * 0.95 + sweep * 1.4, y - hy * 0.6 + lagY * sweep],
        [x + hr * 0.7, y - 1.9],
        [x - 0.3, y - 1.6],
        [x - 1.2, y + 1.6],
      ]),
      H,
      { off: 0.8 },
    );
  }
}
