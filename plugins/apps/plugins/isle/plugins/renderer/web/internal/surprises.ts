// More of the island's secrets, beside easter-eggs.ts: a sea serpent that
// now and then surfaces on the open water in view, fireworks (an old cheat
// code typed on the island; on New Year's Day at night they go up over the
// campfire by themselves), a hero who minds being poked, and snow falling in
// December. Pure drawing and state; the engine says when and where.

import type { Pt } from "@plugins/apps/plugins/isle/plugins/world/core";
import type { Ctx, Rnd } from "./kit";

// ---------------------------------------------------------------- sea serpent

const SERPENT_S = 7;
const SERPENT_GREEN = "#4f8a6a";
const SERPENT_BELLY = "#9cc79a";
const SERPENT_INK = "#1f2a22";

export interface Serpent {
  readonly x: number;
  readonly y: number;
  readonly t0: number;
  /** 1 swims right, -1 left. */
  readonly face: 1 | -1;
}

/** Seconds until the next try, after one surfaced or none could (the view had no open water). */
export const serpentWait = (rnd: Rnd): number => 50 + rnd() * 80;

export const serpentGone = (s: Serpent, t: number): boolean =>
  t - s.t0 > SERPENT_S;

/** Picks where it surfaces: one of the open-water points in view, or none. */
export function surfaceSerpent(
  spots: readonly { x: number; y: number }[],
  inView: (x: number, y: number) => boolean,
  t: number,
  rnd: Rnd,
): Serpent | null {
  const seen = spots.filter((p) => inView(p.x, p.y));
  if (!seen.length) return null;
  const p = seen[(rnd() * seen.length) | 0]!;
  return { x: p.x, y: p.y, t0: t, face: rnd() < 0.5 ? 1 : -1 };
}

/** A hump's top half above the waterline at (x, 0), `h` high. */
function hump(g: Ctx, x: number, w: number, h: number): void {
  if (h < 0.5) return;
  g.beginPath();
  g.ellipse(x, 0, w, h, 0, Math.PI, 0);
  g.closePath();
  g.fillStyle = SERPENT_GREEN;
  g.fill();
  g.strokeStyle = SERPENT_INK;
  g.lineWidth = 1.6;
  g.stroke();
  // a pale stripe and a row of fins along the top
  g.beginPath();
  g.ellipse(x, 0, w * 0.6, h * 0.45, 0, Math.PI, 0);
  g.fillStyle = SERPENT_BELLY;
  g.globalAlpha *= 0.5;
  g.fill();
  g.globalAlpha /= 0.5;
  g.fillStyle = "#c8734d";
  for (const dx of [-0.4, 0, 0.4]) {
    const fx = x + dx * w;
    const fy = -h * Math.sqrt(Math.max(0, 1 - dx * dx));
    g.beginPath();
    g.moveTo(fx - 3, fy + 1);
    g.lineTo(fx, fy - 5);
    g.lineTo(fx + 3, fy + 1);
    g.closePath();
    g.fill();
  }
}

/** The serpent at its point, rising out of the water and sinking back. */
export function drawSerpent(g: Ctx, s: Serpent, t: number): void {
  const k = (t - s.t0) / SERPENT_S;
  if (k < 0 || k > 1) return;
  // up fast, a while above, then down
  const up = Math.min(1, k / 0.18, (1 - k) / 0.22);
  const e = up * up * (3 - 2 * up);
  const drift = (k - 0.5) * 60;
  g.save();
  g.translate(s.x + drift * s.face, s.y);
  g.scale(s.face, 1);
  // rings on the water
  for (let i = 0; i < 3; i++) {
    const r = ((t * 0.6 + i / 3) % 1) * e;
    g.strokeStyle = `rgba(235,248,250,${0.45 * (1 - r) * e})`;
    g.lineWidth = 1.4;
    g.beginPath();
    g.ellipse(0, 1, 30 + r * 70, 6 + r * 14, 0, 0, Math.PI * 2);
    g.stroke();
  }
  const wave = (i: number) => 0.75 + 0.25 * Math.sin(t * 2.2 + i * 1.3);
  // the tail's tip, two humps, then the neck and head
  hump(g, -46, 7, 9 * e * wave(0));
  hump(g, -24, 12, 17 * e * wave(1));
  hump(g, 2, 13, 19 * e * wave(2));
  const nh = 34 * e;
  if (nh > 2) {
    g.save();
    g.translate(22, 0);
    g.beginPath();
    g.moveTo(-6, 0);
    g.quadraticCurveTo(-7, -nh * 0.7, 2, -nh);
    g.lineTo(8, -nh + 2);
    g.quadraticCurveTo(4, -nh * 0.55, 6, 0);
    g.closePath();
    g.fillStyle = SERPENT_GREEN;
    g.fill();
    g.strokeStyle = SERPENT_INK;
    g.lineWidth = 1.6;
    g.stroke();
    // head, a little nod
    g.translate(5, -nh);
    g.rotate(Math.sin(t * 1.7) * 0.12);
    g.beginPath();
    g.ellipse(4, 0, 11, 7, 0, 0, Math.PI * 2);
    g.fill();
    g.stroke();
    g.fillStyle = "#fff8e6";
    g.beginPath();
    g.arc(5, -2.5, 2.6, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = SERPENT_INK;
    // it blinks
    if ((t * 0.7) % 1 > 0.06) {
      g.beginPath();
      g.arc(5.8, -2.4, 1.2, 0, Math.PI * 2);
      g.fill();
    }
    g.strokeStyle = SERPENT_INK;
    g.lineWidth = 1.2;
    g.beginPath();
    g.moveTo(9, 3);
    g.quadraticCurveTo(12, 4.5, 14.5, 2);
    g.stroke();
    g.restore();
  }
  g.restore();
}

/** Its box round its point (world px), for what is in view. */
export const SERPENT_REACH = 120;

// ---------------------------------------------------------------- fireworks

const SHELL_S = 0.9;
const BURST_S = 1.7;
const HUES = [8, 45, 140, 195, 280, 330];

interface Shell {
  readonly x: number;
  readonly y: number;
  readonly t0: number;
  readonly hue: number;
  readonly rise: number;
  readonly sparks: readonly Pt[];
}

/** Rockets going up from a point and bursting (world px, the engine clock). */
export class Fireworks {
  private shells: Shell[] = [];

  constructor(private readonly rnd: Rnd) {}

  get active(): boolean {
    return this.shells.length > 0;
  }

  /** A volley of `n` rockets from around (x, y), one after another. */
  volley(x: number, y: number, t: number, n: number): void {
    const rnd = this.rnd;
    for (let i = 0; i < n; i++) {
      const count = 26 + ((rnd() * 14) | 0);
      const sparks: Pt[] = [];
      for (let j = 0; j < count; j++) {
        const a = (j / count) * Math.PI * 2 + rnd() * 0.2;
        const v = 90 + rnd() * 50;
        sparks.push([Math.cos(a) * v, Math.sin(a) * v]);
      }
      this.shells.push({
        x: x + (rnd() - 0.5) * 220,
        y,
        t0: t + i * (0.25 + rnd() * 0.35),
        hue: HUES[(rnd() * HUES.length) | 0]!,
        rise: 170 + rnd() * 120,
        sparks,
      });
    }
  }

  /** Draws them; best with an additive composite, over the time of day's tint. */
  draw(g: Ctx, t: number): void {
    this.shells = this.shells.filter((s) => t - s.t0 < SHELL_S + BURST_S);
    for (const s of this.shells) {
      const k = t - s.t0;
      if (k < 0) continue;
      if (k < SHELL_S) {
        const p = k / SHELL_S;
        const e = 1 - (1 - p) * (1 - p);
        const y = s.y - s.rise * e;
        g.fillStyle = `hsla(${s.hue},100%,80%,.9)`;
        g.beginPath();
        g.arc(s.x, y, 2.4, 0, Math.PI * 2);
        g.fill();
        g.fillStyle = `hsla(${s.hue},90%,70%,.35)`;
        for (let i = 1; i < 5; i++) {
          g.beginPath();
          g.arc(s.x, y + i * 6, 1.6, 0, Math.PI * 2);
          g.fill();
        }
        continue;
      }
      const b = (k - SHELL_S) / BURST_S;
      const cy = s.y - s.rise;
      const spread = 1 - Math.pow(1 - b, 3);
      const fall = 40 * b * b;
      const a = (1 - b) * (b < 0.08 ? 1 : 0.9);
      g.fillStyle = `hsla(${s.hue},100%,${70 + 20 * (1 - b)}%,${a})`;
      for (const [vx, vy] of s.sparks) {
        const x = s.x + vx * spread;
        const y = cy + vy * spread + fall;
        g.beginPath();
        g.arc(x, y, 2.9 * (1 - b * 0.6), 0, Math.PI * 2);
        g.fill();
      }
      if (b < 0.25) {
        g.fillStyle = `hsla(${s.hue},100%,90%,${0.5 * (1 - b / 0.25)})`;
        g.beginPath();
        g.arc(s.x, cy, 26 * (1 - b), 0, Math.PI * 2);
        g.fill();
      }
    }
  }
}

/** Whether `date` is New Year's Day (local time). */
export const isNewYear = (date: Date): boolean =>
  date.getMonth() === 0 && date.getDate() === 1;

/** Whether it snows on the island on `date`: all of December. */
export const isSnowSeason = (date: Date): boolean => date.getMonth() === 11;

// ---------------------------------------------------------------- the code

const CODE = [
  "ArrowUp",
  "ArrowUp",
  "ArrowDown",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "ArrowLeft",
  "ArrowRight",
  "KeyB",
  "KeyA",
] as const;

/** Listens for the old cheat code, one key code at a time. */
export class CheatCode {
  private at = 0;

  /** Feeds one key code; true when it completes the code. */
  push(code: string): boolean {
    if (code === CODE[this.at]) this.at++;
    else this.at = code === CODE[0] ? 1 : 0;
    if (this.at < CODE.length) return false;
    this.at = 0;
    return true;
  }
}

// ---------------------------------------------------------------- poking the hero

const POKE_GAP_S = 1.6;
const POKE_LINES = [
  "Hm?",
  "Yes?",
  "That tickles!",
  "Hey, stop that!",
  "I'm getting dizzy…",
  "Wheeee!",
  "…okay, that's enough.",
] as const;

/** A line the hero says, shown from `t0` until `until` (engine clock, s). */
export interface HeroLine {
  readonly line: string;
  readonly t0: number;
  readonly until: number;
}

/** The hero being clicked: each poke a little less patient; the fifth spins them round. */
export class Pokes {
  private n = 0;
  private lastAt = -Infinity;
  line: HeroLine | null = null;
  /** Until when (engine clock) the hero spins on the spot. */
  spinUntil = -Infinity;

  poke(t: number): void {
    if (t - this.lastAt > POKE_GAP_S) this.n = 0;
    this.lastAt = t;
    const line = POKE_LINES[Math.min(this.n, POKE_LINES.length - 1)]!;
    this.n++;
    this.line = { line, t0: t, until: t + 1.8 };
    if (line === "Wheeee!") this.spinUntil = t + 1.2;
  }
}

// ---------------------------------------------------------------- snow

/** Snowflakes over the whole view (screen px), drifting with the camera. */
export function drawSnow(
  g: Ctx,
  vw: number,
  vh: number,
  t: number,
  camX: number,
  camY: number,
): void {
  g.save();
  g.fillStyle = "rgba(255,255,255,.85)";
  const n = Math.round((vw * vh) / 9000);
  for (let i = 0; i < n; i++) {
    const h1 = frac(Math.sin(i * 12.9898) * 43758.5453);
    const h2 = frac(Math.sin(i * 78.233) * 12543.1234);
    const depth = 0.4 + frac(h1 * 7.1) * 0.6;
    const r = 1 + depth * 1.8;
    const x = mod(
      h1 * vw - camX * 0.25 * depth + Math.sin(t * 0.8 + i) * 14 + t * 8,
      vw + 20,
    );
    const y = mod(h2 * vh - camY * 0.25 * depth + t * 30 * depth, vh + 20);
    g.globalAlpha = 0.45 + depth * 0.5;
    g.beginPath();
    g.arc(x - 10, y - 10, r, 0, Math.PI * 2);
    g.fill();
  }
  g.restore();
}

const frac = (v: number) => v - Math.floor(v);
const mod = (v: number, m: number) => ((v % m) + m) % m;
