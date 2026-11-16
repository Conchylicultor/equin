// The hero's teleport (a double-click on the ground): the hero is drawn up
// into a column of light where it stands, then dropped out of another where
// it lands, with a ring and a few sparks on the ground. Pure drawing from the
// engine clock; the engine moves the hero at the hand-over.

import type { Ctx } from "./kit";

/** Seconds the hero takes to vanish, then to land. */
export const TELEPORT_OUT = 0.3;
export const TELEPORT_IN = 0.38;

/** A teleport under way (engine clock, s). */
export interface Teleport {
  readonly from: { readonly x: number; readonly y: number };
  readonly to: { readonly x: number; readonly y: number };
  readonly t0: number;
  /** The hero stands at `to` (the hand-over happened). */
  landed: boolean;
}

/** The hero's box while it stretches up (taller than PBOX). */
export const TELEPORT_BOX = [-24, -100, 24, 10] as const;

/** How the hero is drawn now: squeezed thin and tall, and faded, around its feet. */
export function teleportPose(
  tp: Teleport,
  t: number,
): { sx: number; sy: number; alpha: number } {
  const age = t - tp.t0;
  if (age < TELEPORT_OUT) {
    const k = age / TELEPORT_OUT;
    const e = k * k;
    return { sx: 1 - 0.88 * e, sy: 1 + 0.7 * e, alpha: 1 - e };
  }
  const k = Math.min(1, (age - TELEPORT_OUT) / TELEPORT_IN);
  // lands with a small squash before settling
  const back = 1 - Math.pow(1 - k, 3);
  const squash = Math.sin(k * Math.PI) * 0.18 * (k > 0.55 ? 1 : 0);
  return {
    sx: 0.12 + 0.88 * back + squash,
    sy: 1.7 - 0.7 * back - squash,
    alpha: Math.min(1, k * 2.2),
  };
}

/** Whether the teleport has finished. */
export function teleportDone(tp: Teleport, t: number): boolean {
  return t - tp.t0 >= TELEPORT_OUT + TELEPORT_IN + 0.3;
}

/** The columns, rings and sparks, drawn over the scene in world space. */
export function paintTeleportFx(g: Ctx, tp: Teleport, t: number): void {
  const age = t - tp.t0;
  // the column where it leaves: grows to the hand-over, then fades
  const out =
    age < TELEPORT_OUT
      ? age / TELEPORT_OUT
      : Math.max(0, 1 - (age - TELEPORT_OUT) / 0.3);
  // the column where it lands: rises just before the hand-over, fades as it settles
  const inn =
    age < TELEPORT_OUT * 0.6
      ? 0
      : age < TELEPORT_OUT
        ? (age - TELEPORT_OUT * 0.6) / (TELEPORT_OUT * 0.4)
        : Math.max(0, 1 - (age - TELEPORT_OUT) / (TELEPORT_IN + 0.2));
  g.save();
  g.globalCompositeOperation = "lighter";
  column(g, tp.from.x, tp.from.y, out);
  column(g, tp.to.x, tp.to.y, inn);
  sparks(g, tp.from.x, tp.from.y, age, 0);
  sparks(g, tp.to.x, tp.to.y, age - TELEPORT_OUT, 7);
  g.restore();
  // the ring the landing sends over the ground
  const r = (age - TELEPORT_OUT) / 0.55;
  if (r > 0 && r < 1) {
    g.strokeStyle = `rgba(255,248,222,${0.85 * (1 - r)})`;
    g.lineWidth = 2.5 * (1 - r) + 0.5;
    g.beginPath();
    const R = 10 + r * 44;
    g.ellipse(tp.to.x, tp.to.y, R, R * 0.42, 0, 0, 7);
    g.stroke();
  }
}

function column(g: Ctx, x: number, y: number, a: number): void {
  if (a <= 0) return;
  const w = 8 + 14 * a;
  const h = 70 + 80 * a;
  const grad = g.createLinearGradient(0, y - h, 0, y + 4);
  grad.addColorStop(0, "rgba(255,240,200,0)");
  grad.addColorStop(0.6, `rgba(255,236,186,${0.35 * a})`);
  grad.addColorStop(1, `rgba(255,250,230,${0.75 * a})`);
  g.fillStyle = grad;
  g.beginPath();
  g.ellipse(x, y - h / 2 + 2, w, h / 2 + 2, 0, 0, 7);
  g.fill();
  g.fillStyle = `rgba(255,246,214,${0.5 * a})`;
  g.beginPath();
  g.ellipse(x, y, w * 1.6, w * 0.6, 0, 0, 7);
  g.fill();
}

/** A handful of sparks drifting up from (x, y), `age` seconds after they started. */
function sparks(g: Ctx, x: number, y: number, age: number, seed: number): void {
  const life = 0.6;
  for (let i = 0; i < 10; i++) {
    const a = age - (i % 5) * 0.03;
    if (a < 0 || a > life) continue;
    const k = a / life;
    const ang = (i + seed) * 2.39996;
    const r = 6 + 16 * ((i * 37 + seed * 11) % 10) * 0.1;
    const px = x + Math.cos(ang) * r * (0.6 + 0.4 * k);
    const py =
      y - 6 - k * (40 + 30 * ((i * 13) % 7) * 0.15) + Math.sin(ang) * r * 0.3;
    const s = 2.2 * (1 - k) + 0.6;
    g.fillStyle = `rgba(255,244,200,${0.9 * (1 - k)})`;
    g.beginPath();
    g.arc(px, py, s, 0, 7);
    g.fill();
  }
}
