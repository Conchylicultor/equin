// The island's easter eggs — things nobody announces, found by being there at
// the right time: the werewolf that prowls the outskirts at night (howling at
// the moon, bolting when the hero comes near, gone into the dark and back
// later), the full moon and the odd shooting star over the night sky, and the
// bats that circle the campfire at dusk. Pure drawing and motion; the engine
// says when (time of day), where (the layout) and puts them in its passes.

import type { Layout, Pt } from "@plugins/apps/plugins/isle/plugins/world/core";
import { glowSprite, type Ctx, type Rnd } from "./kit";

// ---------------------------------------------------------------- werewolf

/** How near (px, y squashed ×1.4) the hero may come before the werewolf bolts. */
const FLEE_NEAR = 170;
/** How far it runs before it melts into the dark. */
const FLEE_GONE = 520;
const PROWL_SPEED = 34;
const RUN_SPEED = 200;
const HOWL_S = 3.4;
const FADE_S = 0.6;

type WolfMode = "prowl" | "howl" | "flee" | "gone";

/** A line it says, shown from `t0` until `until` (engine clock, s). */
export interface WolfCry {
  readonly line: string;
  readonly t0: number;
  readonly until: number;
}

export class Werewolf {
  x = 0;
  y = 0;
  /** 1 faces right, -1 left. */
  face: 1 | -1 = 1;
  phase = 0;
  cry: WolfCry | null = null;
  private mode: WolfMode = "gone";
  private route: readonly Pt[] | null = null;
  private routeKey: string | null = null;
  private k = 0;
  private dir: 1 | -1 = 1;
  /** Seconds left in the current howl / absence; seconds until the next howl while prowling. */
  private timer = 0;
  private nextHowl = 6;
  /** 0..1: how raised the head is (a howl). */
  private raise = 0;
  /** 0..1: how much of it shows (fades in on arrival, out when gone). */
  private shown = 0;

  constructor(private readonly rnd: Rnd) {}

  /**
   * Takes the outskirts' road: the longest road whose middle is farthest from
   * the campfire square — where nobody would see it.
   */
  follow(layout: Layout): void {
    if (this.route && layout.roads.some((r) => r.key === this.routeKey)) return;
    const camp = layout.squares.find((q) => q.camp) ?? layout.squares[0];
    let best: { pts: readonly Pt[]; key: string } | null = null;
    let score = -Infinity;
    for (const r of layout.roads) {
      if (r.pts.length < 8) continue;
      const m = r.pts[(r.pts.length / 2) | 0]!;
      const far = camp ? Math.hypot(m[0] - camp.x, m[1] - camp.y) : 0;
      const s = far + r.pts.length * 4;
      if (s > score) {
        score = s;
        best = { pts: r.pts, key: r.key };
      }
    }
    this.route = best?.pts ?? null;
    this.routeKey = best?.key ?? null;
    this.mode = "gone";
    this.timer = 2;
    this.shown = 0;
  }

  /** Nightfall: it is somewhere out there, about to show. */
  nightfall(): void {
    this.mode = "gone";
    this.timer = 2 + this.rnd() * 3;
    this.shown = 0;
    this.cry = null;
  }

  get present(): boolean {
    return this.route !== null && this.shown > 0.01;
  }

  /** How much of it shows (0..1). */
  get alpha(): number {
    return this.shown;
  }

  step(dt: number, t: number, hero: { x: number; y: number }): void {
    const route = this.route;
    if (!route) return;
    const rnd = this.rnd;
    const heroD = Math.hypot(hero.x - this.x, (hero.y - this.y) * 1.4);
    this.raise +=
      ((this.mode === "howl" ? 1 : 0) - this.raise) * Math.min(1, dt * 6);
    if (this.mode === "gone") {
      this.shown = Math.max(0, this.shown - dt / FADE_S);
      this.timer -= dt;
      if (this.timer > 0) return;
      // back where the hero is not: the route's point farthest from them
      let k = 0;
      let far = -1;
      route.forEach(([x, y], i) => {
        const d = Math.hypot(x - hero.x, y - hero.y);
        if (d > far) {
          far = d;
          k = i;
        }
      });
      if (far < FLEE_GONE * 0.6) {
        this.timer = 3;
        return;
      }
      this.k = k;
      this.x = route[k]![0];
      this.y = route[k]![1];
      this.dir = k > route.length / 2 ? -1 : 1;
      this.mode = "prowl";
      this.nextHowl = 2 + rnd() * 4;
      return;
    }
    this.shown = Math.min(1, this.shown + dt / FADE_S);
    if (this.mode !== "flee" && heroD < FLEE_NEAR) {
      this.mode = "flee";
      // away from the hero along the road
      const ahead = route[Math.min(route.length - 1, this.k + 3)]!;
      const behind = route[Math.max(0, this.k - 3)]!;
      const dA = Math.hypot(ahead[0] - hero.x, ahead[1] - hero.y);
      const dB = Math.hypot(behind[0] - hero.x, behind[1] - hero.y);
      this.dir = dA >= dB ? 1 : -1;
      this.say(rnd() < 0.5 ? "Grrr…!" : "!!", t, 1.2);
    }
    if (this.mode === "howl") {
      this.timer -= dt;
      if (this.timer <= 0) {
        this.mode = "prowl";
        this.nextHowl = 12 + rnd() * 14;
      }
      return;
    }
    if (this.mode === "flee" && (heroD > FLEE_GONE || this.atEnd())) {
      this.mode = "gone";
      this.timer = 9 + rnd() * 8;
      return;
    }
    if (this.mode === "prowl") {
      this.nextHowl -= dt;
      if (this.nextHowl <= 0) {
        this.mode = "howl";
        this.timer = HOWL_S;
        this.say("Awoooooo!", t, HOWL_S - 0.4);
        return;
      }
    }
    const sp = this.mode === "flee" ? RUN_SPEED : PROWL_SPEED;
    let left = sp * dt;
    while (left > 0) {
      const nk = this.k + this.dir;
      if (nk < 0 || nk >= route.length) {
        if (this.mode === "flee") break;
        this.dir = this.dir === 1 ? -1 : 1;
        break;
      }
      const [gx, gy] = route[nk]!;
      const ex = gx - this.x;
      const ey = gy - this.y;
      const L = Math.hypot(ex, ey);
      if (Math.abs(ex) > 0.5) this.face = ex > 0 ? 1 : -1;
      if (L <= left) {
        this.x = gx;
        this.y = gy;
        this.k = nk;
        left -= L;
        this.phase += L;
      } else {
        this.x += (ex / L) * left;
        this.y += (ey / L) * left;
        this.phase += left;
        left = 0;
      }
    }
  }

  private atEnd(): boolean {
    const nk = this.k + this.dir;
    return !this.route || nk < 0 || nk >= this.route.length;
  }

  private say(line: string, t: number, s: number): void {
    this.cry = { line, t0: t, until: t + s };
  }

  private get running(): boolean {
    return this.mode === "flee";
  }

  /** Draws it at its feet (world px), in its pose. */
  draw(g: Ctx, t: number): void {
    g.save();
    g.globalAlpha *= this.shown;
    g.translate(this.x, this.y);
    paintWerewolf(g, {
      face: this.face,
      phase: this.phase,
      run: this.running,
      raise: this.raise,
      t,
    });
    g.restore();
  }

  /** Where its eyes are (world px), for their glow in the dark. */
  eye(): Pt {
    const [ex, ey] = eyeAt(this.raise);
    return [this.x + ex * this.face, this.y + ey];
  }
}

interface WolfPose {
  readonly face: 1 | -1;
  readonly phase: number;
  readonly run: boolean;
  readonly raise: number;
  readonly t: number;
}

const FUR = "#6e5d55";
const FUR_LIGHT = "#8f7c6e";
const FUR_DARK = "#4a3d37";
const PANTS = "#5b4c82";
const OUTLINE = "#1f1612";

/** The head's centre (local, facing right) for a raise of 0..1. */
function headAt(raise: number): Pt {
  return [13 - 5 * raise, -45 - 9 * raise];
}

function eyeAt(raise: number): Pt {
  const [hx, hy] = headAt(raise);
  const a = -0.95 * raise;
  const [lx, ly] = [3.5, -2.5];
  return [
    hx + lx * Math.cos(a) - ly * Math.sin(a),
    hy + lx * Math.sin(a) + ly * Math.cos(a),
  ];
}

/** A thick inked stroke along points (outline under, fur over). */
function limb(g: Ctx, pts: readonly Pt[], w: number, col: string): void {
  g.beginPath();
  g.moveTo(pts[0]![0], pts[0]![1]);
  for (let i = 1; i < pts.length; i++) g.lineTo(pts[i]![0], pts[i]![1]);
  g.lineCap = "round";
  g.lineJoin = "round";
  g.strokeStyle = OUTLINE;
  g.lineWidth = w + 2.6;
  g.stroke();
  g.strokeStyle = col;
  g.lineWidth = w;
  g.stroke();
}

function leg(g: Ctx, hx: number, swing: number, near: boolean): void {
  g.save();
  g.translate(hx, -24);
  g.rotate(swing);
  // thigh in ragged trousers, then the digitigrade shin and the paw
  limb(
    g,
    [
      [0, 0],
      [5, 9],
    ],
    8,
    near ? PANTS : "#4a3d6c",
  );
  limb(
    g,
    [
      [5, 9],
      [-1, 17],
      [6, 24],
    ],
    5.5,
    near ? FUR : FUR_DARK,
  );
  g.fillStyle = "#e9e1cc";
  for (const dx of [7.5, 9.5]) {
    g.beginPath();
    g.moveTo(dx, 23);
    g.lineTo(dx + 2.2, 24.5);
    g.lineTo(dx, 25);
    g.fill();
  }
  g.restore();
}

function arm(g: Ctx, swing: number, near: boolean, run: boolean): void {
  g.save();
  g.translate(9, -40);
  g.rotate(swing + (run ? -0.6 : 0));
  limb(
    g,
    [
      [0, 0],
      [5, 10],
      [6, 21],
    ],
    5,
    near ? FUR_LIGHT : FUR_DARK,
  );
  // claws
  g.strokeStyle = "#efe7d2";
  g.lineWidth = 1.2;
  g.beginPath();
  for (const dx of [-1.5, 1, 3.5]) {
    g.moveTo(6 + dx, 22);
    g.lineTo(7 + dx * 1.2, 26);
  }
  g.stroke();
  g.restore();
}

/** The werewolf at its feet (0, 0), facing `face`, in a hunched side view. */
function paintWerewolf(g: Ctx, p: WolfPose): void {
  const walkF = p.run ? 0.09 : 0.11;
  const amp = p.run ? 0.75 : 0.42;
  const s = Math.sin(p.phase * walkF) * amp * (1 - p.raise);
  const bob = Math.abs(Math.cos(p.phase * walkF)) * (p.run ? 3 : 1.4);
  // shadow, before the flip and the bob
  g.fillStyle = "rgba(20,24,16,.26)";
  g.beginPath();
  g.ellipse(0, 1, 17, 5, 0, 0, Math.PI * 2);
  g.fill();
  g.save();
  g.scale(p.face, 1);
  g.translate(0, -bob);
  const lean = 0.45 * (1 - p.raise) + (p.run ? 0.25 : 0) - 0.15 * p.raise;

  arm(g, -s, false, p.run);
  leg(g, -3, -s, false);
  // tail, swishing
  const sw = Math.sin(p.t * 3) * 3;
  // a bushy brush: fat at the rump, tapering to a pale tip
  const tx = -25;
  const ty = -17 + sw * 1.4;
  const tail = new Path2D();
  tail.moveTo(-6, -35);
  tail.quadraticCurveTo(-22, -41 + sw, tx - 1, ty - 1);
  tail.quadraticCurveTo(tx, ty + 2, tx + 3, ty + 1);
  tail.quadraticCurveTo(-13, -17 + sw, -6, -24);
  tail.closePath();
  g.fillStyle = FUR;
  g.fill(tail);
  g.save();
  g.clip(tail);
  g.beginPath();
  g.arc(tx + 1, ty - 2, 6, 0, Math.PI * 2);
  g.fillStyle = FUR_LIGHT;
  g.fill();
  g.restore();
  g.strokeStyle = OUTLINE;
  g.lineWidth = 1.6;
  g.lineJoin = "round";
  g.stroke(tail);
  // torso
  g.save();
  g.translate(2, -33);
  g.rotate(lean);
  g.beginPath();
  g.ellipse(0, 0, 11.5, 15, 0, 0, Math.PI * 2);
  g.fillStyle = FUR;
  g.fill();
  g.strokeStyle = OUTLINE;
  g.lineWidth = 1.6;
  g.stroke();
  g.beginPath();
  g.ellipse(4, 3, 5.5, 9, 0, 0, Math.PI * 2);
  g.fillStyle = FUR_LIGHT;
  g.fill();
  // a ruff of fur down the back
  g.fillStyle = FUR_DARK;
  g.beginPath();
  g.moveTo(-8, -11);
  for (let i = 0; i < 5; i++) {
    g.lineTo(-13 - (i % 2) * 3, -8 + i * 4);
  }
  g.lineTo(-9, 10);
  g.closePath();
  g.fill();
  g.restore();
  leg(g, 3, s, true);

  // head: skull, snout, ears; raised toward the moon in a howl
  const [hx, hy] = headAt(p.raise);
  g.save();
  g.translate(hx, hy);
  g.rotate(-0.95 * p.raise);
  g.fillStyle = FUR;
  g.strokeStyle = OUTLINE;
  g.lineWidth = 1.6;
  // ears
  for (const [ex, tilt] of [
    [-5, -0.2],
    [0, 0.15],
  ] as const) {
    g.beginPath();
    g.moveTo(ex - 3, -5);
    g.lineTo(ex - 2 + tilt * 10, -15);
    g.lineTo(ex + 3, -6);
    g.closePath();
    g.fill();
    g.stroke();
  }
  // snout (the jaw drops in a howl)
  const jaw = p.raise * 3.5;
  g.beginPath();
  g.moveTo(3, -4);
  g.lineTo(14, -2);
  g.quadraticCurveTo(16, 0, 14, 1.5);
  g.lineTo(4, 3);
  g.closePath();
  g.fill();
  g.stroke();
  if (jaw > 0.3) {
    g.beginPath();
    g.moveTo(4, 3);
    g.lineTo(13, 1.5 + jaw);
    g.lineTo(4, 5 + jaw * 0.4);
    g.closePath();
    g.fillStyle = "#3a1717";
    g.fill();
    g.stroke();
    g.fillStyle = FUR;
  }
  g.beginPath();
  g.arc(0, -1, 7.5, 0, Math.PI * 2);
  g.fill();
  g.stroke();
  // nose
  g.fillStyle = OUTLINE;
  g.beginPath();
  g.arc(14.5, -1.5, 1.6, 0, Math.PI * 2);
  g.fill();
  // eye
  g.fillStyle = "#ffd84a";
  g.beginPath();
  g.ellipse(3.5, -2.5, 1.9, 1.3, 0, 0, Math.PI * 2);
  g.fill();
  g.restore();
  arm(g, s, true, p.run);
  g.restore();
}

/** Its box round its feet (local px), like a person's. */
export const WOLF_BOX = [-32, -66, 32, 10] as const;

// ---------------------------------------------------------------- night sky

interface ShootingStar {
  x: number;
  y: number;
  vx: number;
  vy: number;
  t0: number;
}

/** The moon and the odd shooting star, over the night (screen px). */
export class NightSky {
  private star: ShootingStar | null = null;
  private nextStar = 6;

  constructor(private readonly rnd: Rnd) {}

  /** Where the moon hangs (screen px) in a viewport of this size. */
  moonAt(vw: number, _vh: number): Pt {
    return [vw - Math.min(140, vw * 0.14), Math.min(120, 40 + vw * 0.05)];
  }

  /**
   * Drawn after the night tint, in screen px: the moon's halo (added light),
   * the moon itself, and a shooting star now and then.
   */
  draw(g: Ctx, vw: number, vh: number, dt: number, t: number): void {
    const [mx, my] = this.moonAt(vw, vh);
    const R = 30;
    g.save();
    g.globalCompositeOperation = "lighter";
    g.drawImage(
      glowSprite("rgba(200,215,255,.42)"),
      mx - R * 5,
      my - R * 5,
      R * 10,
      R * 10,
    );
    g.globalCompositeOperation = "source-over";
    g.beginPath();
    g.arc(mx, my, R, 0, Math.PI * 2);
    const disc = g.createRadialGradient(mx - 8, my - 9, 4, mx, my, R);
    disc.addColorStop(0, "#fffbea");
    disc.addColorStop(1, "#e6dfc2");
    g.fillStyle = disc;
    g.fill();
    g.fillStyle = "rgba(160,150,120,.28)";
    for (const [cx, cy, cr] of [
      [-9, -6, 6],
      [8, 7, 7.5],
      [10, -11, 3.5],
      [-6, 13, 4],
    ] as const) {
      g.beginPath();
      g.arc(mx + cx, my + cy, cr, 0, Math.PI * 2);
      g.fill();
    }
    // the shooting star: a bright head and a fading trail across the top of the sky
    this.nextStar -= dt;
    if (!this.star && this.nextStar <= 0) {
      const rnd = this.rnd;
      const leftward = rnd() < 0.5;
      this.star = {
        x: vw * (0.15 + rnd() * 0.7),
        y: vh * (0.05 + rnd() * 0.25),
        vx: (leftward ? -1 : 1) * (520 + rnd() * 260),
        vy: 180 + rnd() * 120,
        t0: t,
      };
      this.nextStar = 14 + rnd() * 26;
    }
    const st = this.star;
    if (st) {
      const k = (t - st.t0) / 0.9;
      if (k > 1 || k < 0) this.star = null;
      else {
        const hx = st.x + st.vx * (t - st.t0);
        const hy = st.y + st.vy * (t - st.t0);
        const a = Math.sin(k * Math.PI);
        const tr = g.createLinearGradient(
          hx,
          hy,
          hx - st.vx * 0.18,
          hy - st.vy * 0.18,
        );
        tr.addColorStop(0, `rgba(255,250,225,${0.95 * a})`);
        tr.addColorStop(1, "rgba(255,250,225,0)");
        g.strokeStyle = tr;
        g.lineWidth = 2;
        g.lineCap = "round";
        g.beginPath();
        g.moveTo(hx, hy);
        g.lineTo(hx - st.vx * 0.18, hy - st.vy * 0.18);
        g.stroke();
        g.globalCompositeOperation = "lighter";
        g.globalAlpha = a;
        g.drawImage(glowSprite("rgba(255,250,220,.8)"), hx - 8, hy - 8, 16, 16);
      }
    }
    g.restore();
  }
}

// ---------------------------------------------------------------- dusk bats

/** Bats circling a point at dusk (world px), each on its own loop. */
export function drawBats(g: Ctx, cx: number, cy: number, t: number): void {
  g.save();
  g.fillStyle = "#231c22";
  for (let i = 0; i < 6; i++) {
    const a = t * (0.7 + (i % 3) * 0.18) + i * 1.9;
    const r = 70 + (i % 4) * 28;
    const x = cx + Math.cos(a) * r;
    const y = cy - 110 - (i % 3) * 22 + Math.sin(a * 1.7) * 26;
    const f = Math.sin(t * 18 + i * 2.3);
    const w = 7;
    g.beginPath();
    g.moveTo(x, y);
    g.quadraticCurveTo(x - w * 0.5, y - 4 * f - 2, x - w, y - 5 * f);
    g.quadraticCurveTo(x - w * 0.6, y + 1, x, y + 2);
    g.quadraticCurveTo(x + w * 0.6, y + 1, x + w, y - 5 * f);
    g.quadraticCurveTo(x + w * 0.5, y - 4 * f - 2, x, y);
    g.fill();
  }
  g.restore();
}
