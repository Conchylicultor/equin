// The Undercroft — the world inside the well. Nobody announces it: click the
// well and the hero climbs in, falls down the shaft and splashes into the
// Wishing Pool, a cavern seen from the side. Walk it with ← → (or a click),
// read the wishes on the coins, wake the glowcaps, cross the Mirror Lake on
// its arch, talk to the Keeper, and play the song painted on the wall on the
// crystals: the round door rolls aside on the Root Hall, where every app hangs
// as a lantern from the island's roots (click one to open it), round the
// island's heart. Climb the rope (or press Escape) to go back up.
//
// It owns the whole canvas while the hero is down here: the engine hands it
// the frame, the pointer and the keys, and gets the hero back with `leave`.

import type { People, Walker } from "../people";
import { BUBBLE_FONT, drawBubble } from "../chatter";
import { glowSprite, type Ctx } from "../kit";
import {
  paintTeleportFx,
  TELEPORT_OUT,
  teleportDone,
  teleportPose,
  type Teleport,
} from "../teleport";
import {
  CAVE_H,
  CRYSTAL_HUES,
  CRYSTAL_NOTES,
  DOOR_R,
  DOOR_X,
  KEEPER_LINES,
  KEEPER_SOLVED,
  KEEPER_X,
  LAKE,
  MURAL_X,
  POOL,
  ROPE_END,
  SHAFT_TOP,
  SHAFT_X,
  SONG,
  WISHES,
  ceilY,
  floorY,
  HALL_X,
  bedY,
  makeCave,
  zoneAt,
  type Cave,
  type ZoneName,
} from "./cave";
import {
  heartBeat,
  lightCol,
  paintArch,
  paintCrystal,
  paintDoor,
  paintHeart,
  paintIris,
  paintKeeper,
  paintLantern,
  paintMural,
  paintMushroom,
  paintRoot,
  paintThread,
  type Light,
} from "./paint";

export type UndercroftHour = "day" | "dusk" | "night";

/** An app as a lantern draws it. */
export interface UndercroftApp {
  readonly id: string;
  readonly name: string;
  /** Its accent (`#rrggbb`). */
  readonly hue: string;
  /** Its glyph, already tinted for the glass. */
  readonly glyph: CanvasImageSource;
}

/** What the Undercroft asks of the engine. */
export interface UndercroftHost {
  readonly people: People;
  readonly reducedMotion: boolean;
  apps(): readonly UndercroftApp[];
  /** How lived-in an app is (0..1), or null while not known. */
  life(appId: string): number | null;
  hour(): UndercroftHour;
  step(): void;
  chime(midi: number): void;
  whoosh(): void;
  blip(high: boolean): void;
  /** The hero walked into another part of the cave. */
  where(zone: ZoneName): void;
  open(
    appId: string,
    at: { x: number; y: number },
    click: { elsewhere: boolean; keepOthers: boolean },
  ): void;
  /** The hero climbed out (the iris has closed): give it back to the island. */
  leave(): void;
}

/** Played the song this page: the door stays open on the next visit. */
let solvedThisPage = false;

const WALK = 150;
const STEP_PX = 30;
const IRIS_S = 0.8;
const NEAR = 64;

type Mode =
  | { readonly kind: "fall"; vy: number }
  | { readonly kind: "walk" }
  | { readonly kind: "climb" }
  | { readonly kind: "out"; readonly t0: number };

type Thing =
  | { readonly kind: "rope" }
  | { readonly kind: "coin"; readonly i: number }
  | { readonly kind: "mushroom"; readonly i: number }
  | { readonly kind: "crystal"; readonly i: number }
  | { readonly kind: "keeper" }
  | { readonly kind: "lantern"; readonly i: number }
  | { readonly kind: "heart" }
  | { readonly kind: "door" }
  | { readonly kind: "mural" };

interface Bubble {
  readonly x: number;
  readonly y: number;
  readonly text: string;
  readonly t0: number;
  readonly until: number;
  readonly keeper: boolean;
}

interface Mote {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  readonly max: number;
  readonly col: string;
  readonly size: number;
  /** Its fall (px/s², negative rises). */
  readonly grav: number;
}

interface Ring {
  readonly x: number;
  readonly y: number;
  readonly t0: number;
  readonly r: number;
}

export class Undercroft {
  private cave: Cave;
  private appCount: number;
  private readonly hero: Walker = {
    look: "hero",
    x: SHAFT_X,
    y: -60,
    facing: Math.PI / 2,
    walking: false,
    speed: 0,
    phase: 0,
  };
  private stepAt = 0;
  private mode: Mode = { kind: "fall", vy: 0 };
  private target: { x: number; then: Thing | null } | null = null;
  /** The hero vanishing here and landing there along the cave (a double-click). */
  private tp: Teleport | null = null;
  private readonly held = new Set<string>();
  private camX = SHAFT_X;
  private z = 1;
  private vw = 0;
  private vh = 0;
  private t = 0;
  private enteredAt = 0;
  private irisOpenAt = 0;
  private glow: number[] = [];
  private readonly crystalHit: number[] = CRYSTAL_NOTES.map(() => -99);
  private progress = 0;
  private solvedAt: number | null = solvedThisPage ? -99 : null;
  private doorOpen = solvedThisPage ? 1 : 0;
  private shakeUntil = 0;
  private readonly pending: { at: number; i: number }[] = [];
  private keeperAwake = 0;
  private keeperLine = 0;
  private keeperArmed = true;
  private bubble: Bubble | null = null;
  private wishNext = 0;
  private motes: Mote[] = [];
  private rings: Ring[] = [];
  private zone: ZoneName | null = null;
  private heartWave = -99;
  private ptr: { x: number; y: number } | null = null;
  private hoverThing: Thing | null = null;

  constructor(private readonly host: UndercroftHost) {
    this.appCount = host.apps().length;
    this.cave = makeCave(this.appCount);
    this.glow = this.cave.mushrooms.map(() => 0.3);
  }

  /** The hero drops in from the shaft (`at`: a cave x to start standing at instead, e.g. coming back from an app). */
  enter(t: number, at: number | null = null): void {
    const n = this.host.apps().length;
    if (n !== this.appCount) {
      this.appCount = n;
      this.cave = makeCave(n);
      this.glow = this.cave.mushrooms.map(() => 0.3);
    }
    this.t = t;
    this.enteredAt = t;
    this.irisOpenAt = t;
    this.held.clear();
    this.target = null;
    this.bubble = null;
    this.zone = null;
    const h = this.hero;
    h.walking = false;
    h.speed = 0;
    if (at !== null) {
      h.x = this.clampX(at);
      h.y = floorY(h.x);
      h.facing = Math.PI / 2;
      this.mode = { kind: "walk" };
      this.enteredAt = t - 10; // no title card: we have been here
    } else {
      h.x = SHAFT_X;
      h.y = this.host.reducedMotion ? floorY(SHAFT_X) : SHAFT_TOP - 40;
      h.facing = Math.PI / 2;
      this.mode = this.host.reducedMotion
        ? { kind: "walk" }
        : { kind: "fall", vy: 120 };
      this.host.whoosh();
    }
    this.camX = h.x;
  }

  /** Where the hero stands (to come back to after opening an app). */
  get heroX(): number {
    return this.hero.x;
  }

  // ---------------------------------------------------------------- input

  key(code: string, down: boolean): boolean {
    const dir =
      code === "ArrowLeft" || code === "KeyA"
        ? -1
        : code === "ArrowRight" || code === "KeyD"
          ? 1
          : 0;
    if (dir) {
      if (down) {
        this.held.add(code);
        this.target = null;
      } else this.held.delete(code);
      return true;
    }
    if (!down) return code === "ArrowUp" || code === "KeyW" || code === "KeyE";
    if (this.mode.kind !== "walk") return code !== "Tab";
    if (code === "Escape") {
      this.leave();
      return true;
    }
    if (code === "ArrowUp" || code === "KeyW") {
      if (Math.abs(this.hero.x - SHAFT_X) < NEAR) this.climb();
      return true;
    }
    if (code === "KeyE" || code === "Enter" || code === "Space") {
      const th = this.nearestThing();
      if (th) this.act(th, { elsewhere: false, keepOthers: false });
      return true;
    }
    return false;
  }

  /** Keys let go (focus lost). */
  release(): void {
    this.held.clear();
  }

  pointer(sx: number, sy: number): string {
    this.ptr = { x: sx, y: sy };
    return this.hoverThing ? "pointer" : "default";
  }

  pointerLeft(): void {
    this.ptr = null;
  }

  click(
    sx: number,
    sy: number,
    mods: { elsewhere: boolean; keepOthers: boolean },
  ): void {
    if (this.mode.kind !== "walk") return;
    const p = this.toWorld(sx, sy);
    const th = this.thingAt(p.x, p.y);
    if (th) {
      this.act(th, mods);
      return;
    }
    this.target = { x: this.clampX(p.x), then: null };
  }

  private act(
    th: Thing,
    mods: { elsewhere: boolean; keepOthers: boolean },
  ): void {
    const t = this.t;
    const cave = this.cave;
    const face = (x: number) => {
      if (Math.abs(x - this.hero.x) > 4)
        this.hero.facing = x > this.hero.x ? 0 : Math.PI;
    };
    switch (th.kind) {
      case "rope":
        if (Math.abs(this.hero.x - SHAFT_X) < 12) this.climb();
        else this.target = { x: SHAFT_X, then: th };
        return;
      case "coin": {
        const c = cave.coins[th.i]!;
        const wish = WISHES[this.wishNext % WISHES.length]!;
        this.wishNext++;
        this.say(c.x, c.y - 14, wish, 4.5, false);
        this.host.blip(true);
        this.sparkle(c.x, c.y, 45, 8);
        face(c.x);
        return;
      }
      case "mushroom": {
        const m = cave.mushrooms[th.i]!;
        this.glow[th.i] = 1.6;
        const cy = floorY(m.x) - m.h;
        for (let k = 0; k < 14; k++)
          this.motes.push({
            x: m.x + m.lean * m.h + (Math.random() - 0.5) * m.r,
            y: cy - m.r * 0.3,
            vx: (Math.random() - 0.5) * 30,
            vy: -20 - Math.random() * 40,
            life: 0,
            max: 1.5 + Math.random() * 1.5,
            col: `hsla(${m.hue},90%,75%,1)`,
            size: 1.2 + Math.random() * 1.6,
            grav: -6,
          });
        this.host.blip(false);
        face(m.x);
        return;
      }
      case "crystal":
        this.strike(th.i);
        face(cave.crystals[th.i]!);
        return;
      case "keeper":
        this.keeperSpeak();
        face(KEEPER_X);
        return;
      case "lantern": {
        const L = cave.lanterns[th.i]!;
        const app = this.sortedApps()[L.i];
        if (!app) return;
        this.host.blip(true);
        const s = this.toScreen(L.x, L.y + 34);
        this.host.open(app.id, s, mods);
        return;
      }
      case "heart":
        this.heartWave = t;
        this.say(
          cave.heartX,
          floorY(cave.heartX) - 200,
          `The island's heart. A root for every app — ${this.appCount} of them, and room for more.`,
          5,
          false,
        );
        this.host.chime(60);
        face(cave.heartX);
        return;
      case "door":
        if (this.doorOpen < 0.5)
          this.say(
            DOOR_X,
            floorY(DOOR_X) - DOOR_R * 2 - 70,
            "A round stone door, humming like a held note. Five empty sockets ring its edge.",
            4.5,
            false,
          );
        face(DOOR_X);
        return;
      case "mural":
        this.say(
          MURAL_X,
          150,
          "An old painting: five lights rising and falling over a lake.",
          4,
          false,
        );
        face(MURAL_X);
        return;
    }
  }

  /** A double-click: the hero vanishes where it stands and lands under the pointer, on the floor. */
  teleport(sx: number, sy: number): void {
    if (this.mode.kind !== "walk" || this.tp) return;
    const x = this.clampX(this.toWorld(sx, sy).x);
    const h = this.hero;
    this.target = null;
    this.held.clear();
    h.walking = false;
    h.speed = 0;
    if (this.host.reducedMotion) {
      h.x = x;
      h.y = floorY(x);
      return;
    }
    this.tp = {
      from: { x: h.x, y: h.y },
      to: { x, y: floorY(x) },
      t0: this.t,
      landed: false,
    };
  }

  private climb(): void {
    this.target = null;
    this.held.clear();
    this.hero.x = SHAFT_X;
    this.hero.facing = -Math.PI / 2;
    this.mode = { kind: "climb" };
    this.bubble = null;
  }

  /** Back up: the iris closes, then the island takes the hero back. */
  leave(): void {
    if (this.mode.kind === "out") return;
    this.mode = { kind: "out", t0: this.t };
    this.host.whoosh();
  }

  private strike(i: number): void {
    const t = this.t;
    this.crystalHit[i] = t;
    this.host.chime(CRYSTAL_NOTES[i]!);
    const x = this.cave.crystals[i]!;
    this.rings.push({ x, y: floorY(x) - 50, t0: t, r: 90 });
    this.sparkle(x, floorY(x) - 60, CRYSTAL_HUES[i]!, 10);
    if (this.solvedAt !== null) return;
    if (SONG[this.progress] === i) this.progress++;
    else this.progress = SONG[0] === i ? 1 : 0;
    if (this.progress === SONG.length) {
      this.solvedAt = t;
      solvedThisPage = true;
      // the crystals answer with the whole scale, then the door rolls aside
      CRYSTAL_NOTES.forEach((_, k) =>
        this.pending.push({ at: t + 0.6 + k * 0.13, i: k }),
      );
      this.shakeUntil = t + 3.6;
      this.keeperLine = 0;
    }
  }

  private keeperSpeak(): void {
    const solved = this.solvedAt !== null;
    const lines = solved ? KEEPER_SOLVED : KEEPER_LINES;
    const line = lines[Math.min(this.keeperLine, lines.length - 1)]!;
    this.keeperLine++;
    this.keeperAwake = Math.max(this.keeperAwake, 0.6);
    this.say(KEEPER_X - 80, floorY(KEEPER_X) - 110, line, 5, true);
    this.host.blip(false);
  }

  private say(
    x: number,
    y: number,
    text: string,
    s: number,
    keeper: boolean,
  ): void {
    this.bubble = { x, y, text, t0: this.t, until: this.t + s, keeper };
  }

  private sparkle(x: number, y: number, hue: number, n: number): void {
    for (let k = 0; k < n; k++) {
      const a = Math.random() * 6.28;
      const v = 20 + Math.random() * 50;
      this.motes.push({
        x,
        y,
        vx: Math.cos(a) * v,
        vy: Math.sin(a) * v - 20,
        life: 0,
        max: 0.6 + Math.random() * 0.8,
        col: `hsla(${hue},90%,78%,1)`,
        size: 1 + Math.random() * 1.4,
        grav: 40,
      });
    }
  }

  // ---------------------------------------------------------------- geometry

  private clampX(x: number): number {
    const max =
      this.doorOpen > 0.9 ? this.cave.hallEnd - 60 : DOOR_X - DOOR_R - 24;
    return Math.max(50, Math.min(max, x));
  }

  private toWorld(sx: number, sy: number): { x: number; y: number } {
    return {
      x: this.camX + (sx - this.vw / 2) / this.z,
      y: CAVE_H / 2 + (sy - this.vh / 2) / this.z,
    };
  }

  private toScreen(x: number, y: number): { x: number; y: number } {
    return {
      x: (x - this.camX) * this.z + this.vw / 2,
      y: (y - CAVE_H / 2) * this.z + this.vh / 2,
    };
  }

  private sortedApps(): readonly UndercroftApp[] {
    return [...this.host.apps()].sort((a, b) => a.name.localeCompare(b.name));
  }

  private lanternPos(
    i: number,
    t: number,
  ): { x: number; y: number; swing: number } {
    const L = this.cave.lanterns[i]!;
    const swing = Math.sin(t * 0.8 + L.sway) * 0.06;
    return { x: L.x, y: L.y, swing };
  }

  /** What is under world point (x, y) that answers a click. */
  private thingAt(x: number, y: number): Thing | null {
    const cave = this.cave;
    const t = this.t;
    if (this.doorOpen > 0.9)
      for (let i = 0; i < cave.lanterns.length; i++) {
        const p = this.lanternPos(i, t);
        if (Math.abs(x - p.x) < 20 && y > p.y && y < p.y + 56)
          return { kind: "lantern", i };
      }
    if (
      Math.abs(x - cave.heartX) < 60 &&
      Math.abs(y - (floorY(cave.heartX) - 110)) < 80
    )
      return { kind: "heart" };
    if (Math.abs(x - SHAFT_X) < 16 && y > SHAFT_TOP && y < ROPE_END + 10)
      return { kind: "rope" };
    for (let i = 0; i < cave.crystals.length; i++) {
      const cx = cave.crystals[i]!;
      if (Math.abs(x - cx) < 32 && y < floorY(cx) + 6 && y > floorY(cx) - 110)
        return { kind: "crystal", i };
    }
    for (let i = 0; i < cave.coins.length; i++) {
      const c = cave.coins[i]!;
      if (Math.hypot(x - c.x, y - c.y) < 12) return { kind: "coin", i };
    }
    if (
      Math.abs(x - (KEEPER_X - 20)) < 120 &&
      y > floorY(KEEPER_X) - 90 &&
      y < floorY(KEEPER_X) + 10
    )
      return { kind: "keeper" };
    for (let i = 0; i < cave.mushrooms.length; i++) {
      const m = cave.mushrooms[i]!;
      const cx = m.x + m.lean * m.h;
      const cy = floorY(m.x) + (m.front ? 14 : 2) - m.h;
      if (Math.abs(x - cx) < m.r && y > cy - m.r * 0.8 && y < cy + m.r * 0.3)
        return { kind: "mushroom", i };
    }
    if (
      this.doorOpen < 0.5 &&
      Math.hypot(x - DOOR_X, y - (floorY(DOOR_X) - DOOR_R)) < DOOR_R
    )
      return { kind: "door" };
    if (Math.abs(x - MURAL_X) < 150 && Math.abs(y - 150) < 75)
      return { kind: "mural" };
    return null;
  }

  /** The thing the hero stands by, for E / Enter. */
  private nearestThing(): Thing | null {
    const cave = this.cave;
    const hx = this.hero.x;
    let best: Thing | null = null;
    let bd = NEAR;
    const consider = (th: Thing, x: number) => {
      const d = Math.abs(x - hx);
      if (d < bd) {
        bd = d;
        best = th;
      }
    };
    consider({ kind: "rope" }, SHAFT_X);
    cave.crystals.forEach((x, i) => consider({ kind: "crystal", i }, x));
    cave.coins.forEach((c, i) => consider({ kind: "coin", i }, c.x));
    if (this.doorOpen > 0.9)
      cave.lanterns.forEach((L, i) => consider({ kind: "lantern", i }, L.x));
    consider({ kind: "keeper" }, KEEPER_X - 60);
    consider({ kind: "heart" }, cave.heartX);
    if (this.doorOpen < 0.5) consider({ kind: "door" }, DOOR_X - DOOR_R);
    return best;
  }

  // ---------------------------------------------------------------- the frame

  frame(
    g: Ctx,
    dt: number,
    t: number,
    vw: number,
    vh: number,
    dpr: number,
  ): void {
    this.t = t;
    this.vw = vw;
    this.vh = vh;
    this.z = vh / CAVE_H;
    this.update(dt, t);
    this.paint(g, t, dpr);
  }

  private update(dt: number, t: number): void {
    const h = this.hero;
    const cave = this.cave;
    const m = this.mode;
    if (m.kind === "fall") {
      m.vy += 900 * dt;
      h.y += m.vy * dt;
      const fy = floorY(h.x);
      if (h.y >= fy) {
        h.y = fy;
        this.mode = { kind: "walk" };
        // the splash
        this.rings.push({ x: h.x, y: POOL.surface + 6, t0: t, r: 70 });
        this.rings.push({ x: h.x, y: POOL.surface + 6, t0: t + 0.15, r: 110 });
        for (let k = 0; k < 26; k++)
          this.motes.push({
            x: h.x + (Math.random() - 0.5) * 20,
            y: POOL.surface,
            vx: (Math.random() - 0.5) * 160,
            vy: -80 - Math.random() * 160,
            life: 0,
            max: 0.7 + Math.random() * 0.5,
            col: "hsla(190,70%,80%,1)",
            size: 1.4 + Math.random() * 1.8,
            grav: 300,
          });
        this.host.blip(false);
      }
    } else if (m.kind === "climb") {
      h.y -= 80 * dt;
      h.walking = true;
      h.speed = 80;
      h.phase += 80 * dt;
      if (h.y < SHAFT_TOP + 160) this.leave();
    } else if (m.kind === "walk" && this.tp) {
      const tp = this.tp;
      if (!tp.landed && t - tp.t0 >= TELEPORT_OUT) {
        tp.landed = true;
        h.x = tp.to.x;
        h.y = tp.to.y;
      }
      if (teleportDone(tp, t)) this.tp = null;
    } else if (m.kind === "walk") {
      let dir = 0;
      for (const c of this.held)
        dir +=
          c === "ArrowLeft" || c === "KeyA"
            ? -1
            : c === "ArrowRight" || c === "KeyD"
              ? 1
              : 0;
      if (!dir && this.target) {
        const d = this.target.x - h.x;
        if (Math.abs(d) < 3) {
          const then = this.target.then;
          this.target = null;
          if (then) this.act(then, { elsewhere: false, keepOthers: false });
        } else dir = Math.sign(d);
      }
      const nx = this.clampX(h.x + dir * WALK * dt);
      const moved = Math.abs(nx - h.x);
      if (moved > 0.01) {
        h.x = nx;
        h.facing = dir > 0 ? 0 : Math.PI;
        h.walking = true;
        h.speed = WALK;
        h.phase += moved;
      } else {
        h.walking = false;
        h.speed = 0;
        if (dir && this.target) this.target = null;
      }
      h.y = floorY(h.x);
      if (h.phase - this.stepAt > STEP_PX) {
        this.stepAt = h.phase;
        this.host.step();
        if (h.x > POOL.x0 && h.x < POOL.x1)
          this.rings.push({ x: h.x, y: POOL.surface + 8, t0: t, r: 26 });
      }
    }
    // where the hero is
    const zone = zoneAt(cave, h.x);
    if (zone !== this.zone) {
      this.zone = zone;
      this.host.where(zone);
    }
    // the glowcaps brighten as the hero passes
    const night = this.host.hour() === "night";
    cave.mushrooms.forEach((mu, i) => {
      const near = Math.max(0, 1 - Math.abs(mu.x - h.x) / 140);
      const goal = Math.max(night ? 0.45 : 0.3, near);
      const cur = this.glow[i]!;
      this.glow[i] =
        cur + (goal - cur) * Math.min(1, dt * (cur > goal ? 0.8 : 3));
    });
    // the keeper wakes as the hero comes near, and speaks once per approach
    const kd = Math.abs(h.x - KEEPER_X);
    this.keeperAwake +=
      ((kd < 300 ? 1 : 0) - this.keeperAwake) * Math.min(1, dt * 1.2);
    if (
      kd < 230 &&
      this.keeperArmed &&
      this.keeperAwake > 0.7 &&
      this.mode.kind === "walk"
    ) {
      this.keeperArmed = false;
      this.keeperSpeak();
    }
    if (kd > 480) this.keeperArmed = true;
    // the song's answer, then the door
    for (let k = this.pending.length - 1; k >= 0; k--) {
      const p = this.pending[k]!;
      if (t >= p.at) {
        this.crystalHit[p.i] = t;
        this.host.chime(CRYSTAL_NOTES[p.i]!);
        this.pending.splice(k, 1);
      }
    }
    if (this.solvedAt !== null && this.doorOpen < 1) {
      const k = Math.min(1, Math.max(0, (t - this.solvedAt - 1.4) / 2.4));
      this.doorOpen =
        this.host.reducedMotion && k > 0 ? 1 : Math.min(1, k * k * (3 - 2 * k));
    }
    // motes and rings
    for (const mo of this.motes) {
      mo.life += dt;
      mo.x += mo.vx * dt;
      mo.y += mo.vy * dt;
      mo.vy += mo.grav * dt;
      mo.vx *= 1 - dt * 0.8;
    }
    this.motes = this.motes.filter((mo) => mo.life < mo.max);
    this.rings = this.rings.filter((r) => t - r.t0 < 1.4);
    if (this.bubble && t > this.bubble.until + 0.4) this.bubble = null;
    // the camera: ahead of the hero a little, never past the cave's ends
    const hw = this.vw / 2 / this.z;
    const ahead = h.walking
      ? h.facing === 0
        ? 70
        : h.facing === Math.PI
          ? -70
          : 0
      : 0;
    let goal = h.x + ahead;
    const right = (this.doorOpen > 0.05 ? cave.width : DOOR_X + 260) - hw;
    goal = Math.max(hw, Math.min(right, goal));
    if (right < hw) goal = (hw + right) / 2;
    this.camX +=
      (goal - this.camX) * (this.host.reducedMotion ? 1 : Math.min(1, dt * 3));
    // the pointer's hover
    this.hoverThing =
      this.ptr && this.mode.kind === "walk"
        ? this.thingAt(
            this.toWorld(this.ptr.x, this.ptr.y).x,
            this.toWorld(this.ptr.x, this.ptr.y).y,
          )
        : null;
    if (this.mode.kind === "out" && t - this.mode.t0 > IRIS_S)
      this.host.leave();
  }

  private paint(g: Ctx, t: number, dpr: number): void {
    const { vw, vh, z } = this;
    const cave = this.cave;
    const hour = this.host.hour();
    const lights: Light[] = [];
    const shake =
      t < this.shakeUntil &&
      this.solvedAt !== null &&
      t > this.solvedAt + 1.3 &&
      !this.host.reducedMotion
        ? Math.sin(t * 61) * 2.2 * Math.min(1, this.shakeUntil - t)
        : 0;
    const x0 = this.camX - vw / 2 / z - 120;
    const x1 = this.camX + vw / 2 / z + 120;
    const inView = (x: number, pad = 0) => x > x0 - pad && x < x1 + pad;
    const world = (p = 1) =>
      g.setTransform(
        dpr * z,
        0,
        0,
        dpr * z,
        dpr * (vw / 2 - this.camX * p * z + shake),
        dpr * (vh / 2 - (CAVE_H / 2) * z),
      );

    // --- the dark: the back of the cave, far rock in parallax
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.globalCompositeOperation = "source-over";
    g.globalAlpha = 1;
    const bg = g.createLinearGradient(0, 0, 0, vh);
    bg.addColorStop(0, "#071012");
    bg.addColorStop(0.55, "#0d1c20");
    bg.addColorStop(1, "#060b0c");
    g.fillStyle = bg;
    g.fillRect(0, 0, vw, vh);
    world(0.4);
    g.fillStyle = "#0f1f23";
    g.beginPath();
    for (const [fx, w, fh] of cave.far) {
      g.moveTo(fx - w, 520);
      g.quadraticCurveTo(fx - w * 0.4, 520 - fh, fx, 520 - fh * 0.92);
      g.quadraticCurveTo(fx + w * 0.5, 520 - fh * 0.8, fx + w, 520);
    }
    g.fill();
    g.fillStyle = "#0c181b";
    g.beginPath();
    for (const [fx, w, fh] of cave.far) {
      g.moveTo(fx - w * 0.8 + 80, 0);
      g.lineTo(fx + 80, fh * 0.45);
      g.lineTo(fx + w * 0.7 + 80, 0);
    }
    g.fill();
    world(0.7);
    // mineral glints in the back wall
    for (let i = 0; i < 90; i++) {
      const gx = ((i * 977) % 6000) + ((i * 37) % 13);
      const gy = 140 + ((i * 523) % 300);
      const tw = Math.sin(t * (0.6 + (i % 5) * 0.2) + i);
      if (tw < 0.6) continue;
      g.fillStyle = `rgba(190,230,255,${(tw - 0.6) * 1.2})`;
      g.fillRect(gx, gy, 1.4, 1.4);
    }

    world();
    // --- the shaft of light from the well, and the sky's coin of it
    const sky =
      hour === "night" ? "#9fb8ff" : hour === "dusk" ? "#ffb27a" : "#fff3d6";
    if (inView(SHAFT_X, 300)) {
      const fy = floorY(SHAFT_X);
      g.globalCompositeOperation = "lighter";
      const sg = g.createLinearGradient(0, SHAFT_TOP, 0, fy);
      sg.addColorStop(0, hexA(sky, 0.38));
      sg.addColorStop(1, hexA(sky, 0.04));
      g.fillStyle = sg;
      g.beginPath();
      g.moveTo(SHAFT_X - 30, SHAFT_TOP);
      g.lineTo(SHAFT_X + 30, SHAFT_TOP);
      g.lineTo(SHAFT_X + 120, fy + 10);
      g.lineTo(SHAFT_X - 100, fy + 10);
      g.closePath();
      g.fill();
      g.globalCompositeOperation = "source-over";
      // dust turning in it
      for (let i = 0; i < 40; i++) {
        const k = (((t * 0.03 + i * 0.137) % 1) + 1) % 1;
        const my = SHAFT_TOP + k * (fy - SHAFT_TOP);
        const spread = 30 + k * 95;
        const mx = SHAFT_X + Math.sin(i * 12.9 + t * 0.2) * spread * 0.8;
        g.fillStyle = hexA(sky, 0.5 * Math.sin(k * Math.PI));
        g.fillRect(mx, my, 1.3, 1.3);
      }
      lights.push({
        x: SHAFT_X,
        y: fy - 20,
        r: 180,
        col: lightCol(hour === "night" ? 220 : 40),
        a: 0.35,
      });
    }

    // --- the ceiling: rock, stalactites, the shaft's mouth
    g.fillStyle = "#081013";
    g.beginPath();
    g.moveTo(x0, 0);
    for (let x = Math.floor(x0 / 16) * 16; x <= x1; x += 16)
      g.lineTo(x, ceilY(x, HALL_X));
    g.lineTo(x1, 0);
    g.closePath();
    g.fill();
    g.strokeStyle = "rgba(120,170,175,.12)";
    g.lineWidth = 2;
    g.beginPath();
    for (let x = Math.floor(x0 / 16) * 16; x <= x1; x += 16)
      if (x === Math.floor(x0 / 16) * 16) g.moveTo(x, ceilY(x, HALL_X));
      else g.lineTo(x, ceilY(x, HALL_X));
    g.stroke();
    g.fillStyle = "#081013";
    for (const s of cave.stalactites) {
      if (!inView(s.x, 40)) continue;
      const cy = ceilY(s.x, HALL_X) - 4;
      g.beginPath();
      g.moveTo(s.x - s.w / 2, cy);
      g.quadraticCurveTo(s.x - s.w * 0.1, cy + s.h * 0.7, s.x, cy + s.h);
      g.quadraticCurveTo(s.x + s.w * 0.1, cy + s.h * 0.7, s.x + s.w / 2, cy);
      g.closePath();
      g.fill();
      // a drip, now and then, from the longer ones
      if (s.h > 50) {
        const per = 3 + (s.x % 5);
        const k = ((t + s.x * 0.37) % per) / per;
        if (k > 0.85) {
          const dk = (k - 0.85) / 0.15;
          g.fillStyle = "rgba(170,220,230,.6)";
          g.fillRect(
            s.x - 0.8,
            cy + s.h + dk * (floorY(s.x) - cy - s.h),
            1.6,
            4,
          );
          g.fillStyle = "#081013";
        }
      }
    }
    if (inView(SHAFT_X, 100)) {
      g.fillStyle = sky;
      g.beginPath();
      g.ellipse(SHAFT_X, SHAFT_TOP - 6, 26, 9, 0, 0, 7);
      g.fill();
      g.strokeStyle = "#1a2528";
      g.lineWidth = 6;
      g.stroke();
      // the rope
      g.strokeStyle = "#6d5638";
      g.lineWidth = 2.4;
      g.beginPath();
      g.moveTo(SHAFT_X, SHAFT_TOP - 6);
      g.quadraticCurveTo(
        SHAFT_X + Math.sin(t * 0.7) * 4,
        (SHAFT_TOP + ROPE_END) / 2,
        SHAFT_X + Math.sin(t * 0.7 + 0.6) * 6,
        ROPE_END,
      );
      g.stroke();
      g.strokeStyle = "rgba(255,230,180,.25)";
      g.lineWidth = 0.8;
      g.stroke();
      // a knot at its end
      g.fillStyle = "#6d5638";
      g.beginPath();
      g.arc(SHAFT_X + Math.sin(t * 0.7 + 0.6) * 6, ROPE_END + 2, 4, 0, 7);
      g.fill();
    }

    // --- glowworm threads
    const bright = hour === "night" ? 1.25 : 1;
    for (const th of cave.threads)
      if (inView(th.x))
        paintThread(
          g,
          th.x,
          ceilY(th.x, HALL_X) - 2,
          th.len,
          th.ph,
          t,
          bright,
          lights,
        );

    // --- on the back wall: the mural, the door, the hall's roots and heart
    if (inView(MURAL_X, 200))
      paintMural(
        g,
        MURAL_X,
        150,
        this.progress,
        this.solvedAt !== null,
        t,
        lights,
      );
    if (inView(DOOR_X, 300))
      paintDoor(
        g,
        DOOR_X,
        this.progress,
        this.solvedAt !== null,
        this.doorOpen,
        t,
        lights,
      );
    const apps = this.sortedApps();
    if (x1 > HALL_X - 200) this.paintHall(g, apps, t, lights, inView);

    // --- the floor
    const fg = g.createLinearGradient(0, 430, 0, CAVE_H);
    fg.addColorStop(0, "#162427");
    fg.addColorStop(1, "#050909");
    g.fillStyle = fg;
    g.beginPath();
    g.moveTo(x0, CAVE_H + 10);
    for (let x = Math.floor(x0 / 12) * 12; x <= x1; x += 12)
      g.lineTo(x, bedY(x));
    g.lineTo(x1, CAVE_H + 10);
    g.closePath();
    g.fill();
    g.strokeStyle = "rgba(150,200,190,.16)";
    g.lineWidth = 2;
    g.beginPath();
    let first = true;
    for (let x = Math.floor(x0 / 12) * 12; x <= x1; x += 12) {
      if (x > LAKE.x0 + 40 && x < LAKE.x1 - 40) {
        first = true;
        continue;
      }
      if (first) g.moveTo(x, bedY(x));
      else g.lineTo(x, bedY(x));
      first = false;
    }
    g.stroke();
    // the cave's two ends
    g.fillStyle = "#081013";
    // the cave's two ends: rough rock walls
    for (const [edge, dir] of [
      [0, -1],
      [cave.width, 1],
    ] as const) {
      if (!inView(edge, 200)) continue;
      g.beginPath();
      g.moveTo(edge + dir * 400, 0);
      for (let y = 0; y <= CAVE_H; y += 30)
        g.lineTo(
          edge -
            dir *
              (30 + 22 * Math.sin(y * 0.05 + edge) + 10 * Math.sin(y * 0.17)),
          y,
        );
      g.lineTo(edge + dir * 400, CAVE_H);
      g.closePath();
      g.fill();
    }

    // --- the lake: water, its reflections, fish, the arch over it
    if (x1 > LAKE.x0 && x0 < LAKE.x1) this.paintLake(g, t, lights);

    // --- the pool: coins under the water
    if (inView(POOL.x0, 300) || inView(POOL.x1, 300)) {
      for (const c of cave.coins) {
        g.fillStyle = "#b8923a";
        g.beginPath();
        g.ellipse(c.x, c.y, 4.5, 1.8, 0, 0, 7);
        g.fill();
        g.fillStyle = "#e8c66a";
        g.beginPath();
        g.ellipse(c.x - 0.8, c.y - 0.5, 2.6, 0.9, 0, 0, 7);
        g.fill();
        const tw = Math.sin(t * 1.7 + c.x);
        if (tw > 0.92) {
          const s = (tw - 0.92) * 60;
          g.strokeStyle = "rgba(255,240,200,.9)";
          g.lineWidth = 0.8;
          g.beginPath();
          g.moveTo(c.x - s, c.y - 2);
          g.lineTo(c.x + s, c.y - 2);
          g.moveTo(c.x, c.y - 2 - s);
          g.lineTo(c.x, c.y - 2 + s);
          g.stroke();
        }
      }
    }

    // --- the keeper and the crystals, behind the path
    if (inView(KEEPER_X, 260))
      paintKeeper(
        g,
        KEEPER_X,
        this.keeperAwake,
        this.bubble?.keeper === true && t < this.bubble.until,
        t,
        lights,
      );
    cave.crystals.forEach((x, i) => {
      if (!inView(x, 80)) return;
      const k = t - this.crystalHit[i]!;
      paintCrystal(g, x, i, k >= 0 ? Math.exp(-k * 1.4) : 0, t, lights);
    });
    // back glowcaps
    cave.mushrooms.forEach((m, i) => {
      if (!m.front && inView(m.x, 80))
        paintMushroom(g, m, Math.min(1.4, this.glow[i]!), t, lights);
    });

    // --- the hero
    const h = this.hero;
    // in the air (falling, on the rope) it casts no shadow on the floor
    const grounded = this.mode.kind === "walk" || h.y >= floorY(h.x) - 1;
    const tp = this.tp;
    if (tp) {
      const pose = teleportPose(tp, t);
      if (pose.alpha > 0.01) {
        g.save();
        g.globalAlpha *= pose.alpha;
        g.translate(h.x, h.y);
        g.scale(pose.sx, pose.sy);
        g.translate(-h.x, -h.y);
        this.host.people.draw(g, h, t, grounded);
        g.restore();
      }
      paintTeleportFx(g, tp, t);
    } else this.host.people.draw(g, h, t, grounded);
    lights.push({ x: h.x, y: h.y - 30, r: 70, col: lightCol(40), a: 0.12 });

    // --- the pool's water, over the hero's feet
    if (inView(POOL.x0, 300) || inView(POOL.x1, 300)) {
      // the water stands flat over the basin, wherever the floor dips below it
      let wx0 = Infinity;
      let wx1 = -Infinity;
      for (let x = POOL.x0 - 60; x <= POOL.x1 + 60; x += 2)
        if (floorY(x) > POOL.surface) {
          wx0 = Math.min(wx0, x);
          wx1 = Math.max(wx1, x);
        }
      if (wx1 > wx0) {
        g.beginPath();
        g.moveTo(wx0, POOL.surface);
        for (let x = wx0; x <= wx1; x += 4) g.lineTo(x, floorY(x) + 1);
        g.lineTo(wx1, POOL.surface);
        g.closePath();
        const wg = g.createLinearGradient(
          0,
          POOL.surface,
          0,
          POOL.surface + 18,
        );
        wg.addColorStop(0, "rgba(90,170,190,.42)");
        wg.addColorStop(1, "rgba(30,80,100,.55)");
        g.fillStyle = wg;
        g.fill();
        g.strokeStyle = "rgba(200,240,245,.45)";
        g.lineWidth = 1.2;
        g.beginPath();
        g.moveTo(wx0, POOL.surface);
        g.lineTo(wx1, POOL.surface);
        g.stroke();
      }
    }
    // rings on the water
    for (const r of this.rings) {
      const k = (t - r.t0) / 1.4;
      if (k < 0) continue;
      g.strokeStyle = `rgba(190,235,240,${0.55 * (1 - k)})`;
      g.lineWidth = 1.2;
      g.beginPath();
      g.ellipse(r.x, r.y, r.r * k, r.r * k * 0.18, 0, 0, 7);
      g.stroke();
    }

    // --- the near row of glowcaps, in front of everything
    cave.mushrooms.forEach((m, i) => {
      if (m.front && inView(m.x, 80))
        paintMushroom(g, m, Math.min(1.4, this.glow[i]!), t, lights);
    });

    // --- every light at once, added
    g.globalCompositeOperation = "lighter";
    for (const L of lights) {
      if (!inView(L.x, L.r)) continue;
      g.globalAlpha = Math.min(1, L.a);
      g.drawImage(glowSprite(L.col), L.x - L.r, L.y - L.r, L.r * 2, L.r * 2);
    }
    g.globalAlpha = 1;
    // spores, sparks, splashes
    for (const mo of this.motes) {
      const a = Math.sin((mo.life / mo.max) * Math.PI);
      g.fillStyle = mo.col.replace(",1)", `,${a.toFixed(3)})`);
      g.beginPath();
      g.arc(mo.x, mo.y, mo.size, 0, 7);
      g.fill();
    }
    // the crystals' rings of sound
    for (const r of this.rings) {
      if (r.r < 80) continue;
      const k = (t - r.t0) / 1.4;
      if (k < 0 || r.y > 440) continue;
      g.strokeStyle = `rgba(220,240,255,${0.35 * (1 - k)})`;
      g.lineWidth = 2;
      g.beginPath();
      g.arc(r.x, r.y, 20 + r.r * k, 0, 7);
      g.stroke();
    }
    g.globalCompositeOperation = "source-over";

    // --- screen space: vignette, names, bubbles, the title, the iris
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const vg = g.createRadialGradient(
      vw / 2,
      vh / 2,
      Math.min(vw, vh) * 0.3,
      vw / 2,
      vh / 2,
      Math.max(vw, vh) * 0.75,
    );
    vg.addColorStop(0, "rgba(0,0,0,0)");
    vg.addColorStop(1, "rgba(0,0,0,.6)");
    g.fillStyle = vg;
    g.fillRect(0, 0, vw, vh);
    this.paintNames(g, apps, t);
    const b = this.bubble;
    if (b) {
      const a =
        Math.min(1, (t - b.t0) / 0.2) *
        Math.max(0, Math.min(1, 1 - (t - b.until) / 0.35));
      const s = this.toScreen(b.x, b.y);
      if (a > 0) drawBubble(g, s.x + shake, s.y, b.text, a);
    }
    this.paintTitle(g, t);
    // the iris: opening on the shaft as the hero arrives, closing as it leaves
    const reduced = this.host.reducedMotion;
    const full = Math.hypot(vw, vh);
    if (this.mode.kind === "out") {
      const k = reduced ? 1 : Math.min(1, (t - this.mode.t0) / IRIS_S);
      const c = this.toScreen(h.x, h.y - 30);
      paintIris(g, vw, vh, c.x, c.y, full * (1 - easeIO(k)));
    } else if (!reduced && t - this.irisOpenAt < IRIS_S) {
      const k = (t - this.irisOpenAt) / IRIS_S;
      const c = this.toScreen(SHAFT_X, SHAFT_TOP + 40);
      paintIris(g, vw, vh, c.x, c.y, full * easeIO(k));
    }
  }

  private paintLake(g: Ctx, t: number, lights: Light[]): void {
    const S = LAKE.surface;
    const wg = g.createLinearGradient(0, S, 0, CAVE_H);
    wg.addColorStop(0, "#0d2a33");
    wg.addColorStop(1, "#030b0e");
    g.fillStyle = wg;
    g.fillRect(LAKE.x0 + 20, S, LAKE.x1 - LAKE.x0 - 40, CAVE_H - S + 10);
    // the threads' lights, mirrored in the still water
    g.globalCompositeOperation = "lighter";
    for (const th of this.cave.threads) {
      if (th.x < LAKE.x0 + 30 || th.x > LAKE.x1 - 30) continue;
      const tip = ceilY(th.x, HALL_X) + th.len;
      const ry = S + (S - tip) * 0.18;
      const wob = Math.sin(t * 1.4 + th.x * 0.05) * 2;
      g.fillStyle = "rgba(120,255,235,.35)";
      g.fillRect(th.x + wob - 1.5, ry, 3, 1.4);
    }
    // the sky's coin, too far to see, and shimmer lines
    for (let i = 0; i < 40; i++) {
      const sx = LAKE.x0 + 40 + ((i * 263) % (LAKE.x1 - LAKE.x0 - 80));
      const sy = S + 4 + ((i * 37) % 60);
      const a = 0.12 * (0.5 + 0.5 * Math.sin(t * 0.9 + i * 1.3));
      g.fillStyle = `rgba(160,220,230,${a})`;
      g.fillRect(sx, sy, 10 + (i % 4) * 6, 1);
    }
    // glowing fish, swimming; one leaps now and then
    for (let i = 0; i < 6; i++) {
      const span = LAKE.x1 - LAKE.x0 - 160;
      const per = 18 + i * 3;
      const k = (((t / per + i * 0.23) % 1) + 1) % 1;
      const dir = i % 2 ? 1 : -1;
      const fx = LAKE.x0 + 80 + (dir > 0 ? k : 1 - k) * span;
      let fy = S + 18 + i * 9 + Math.sin(t * 1.3 + i) * 4;
      const jumpPer = 9 + i * 2.3;
      const jk = ((t + i * 4.1) % jumpPer) / jumpPer;
      const jumping = jk < 0.07;
      if (jumping) {
        const p = jk / 0.07;
        fy = S - Math.sin(p * Math.PI) * 46;
        if (
          p > 0.92 &&
          !this.rings.some((r) => Math.abs(r.x - fx) < 30 && t - r.t0 < 0.4)
        )
          this.rings.push({ x: fx, y: S + 2, t0: t, r: 40 });
      }
      const hue = [180, 200, 300, 170, 40, 190][i]!;
      g.fillStyle = `hsla(${hue},90%,70%,${jumping ? 0.95 : 0.55})`;
      g.beginPath();
      g.ellipse(fx, fy, 7, 2.6, jumping ? -dir * 0.5 : 0, 0, 7);
      g.moveTo(fx - dir * 6, fy);
      g.lineTo(fx - dir * 12, fy - 3);
      g.lineTo(fx - dir * 12, fy + 3);
      g.fill();
      lights.push({
        x: fx,
        y: fy,
        r: jumping ? 40 : 26,
        col: lightCol(hue),
        a: jumping ? 0.5 : 0.3,
      });
    }
    g.globalCompositeOperation = "source-over";
    // stalagmites standing in the water
    g.fillStyle = "#0b1518";
    for (const s of this.cave.stalagmites) {
      g.beginPath();
      g.moveTo(s.x - s.w / 2, S + 30);
      g.quadraticCurveTo(s.x - s.w * 0.15, S - s.h * 0.5, s.x, S - s.h);
      g.quadraticCurveTo(
        s.x + s.w * 0.15,
        S - s.h * 0.5,
        s.x + s.w / 2,
        S + 30,
      );
      g.closePath();
      g.fill();
    }
    // the arch's reflection, upside down in the still water
    g.save();
    g.beginPath();
    g.rect(LAKE.x0 + 20, S, LAKE.x1 - LAKE.x0 - 40, CAVE_H - S + 10);
    g.clip();
    g.translate(0, S * 2);
    g.scale(1, -1);
    g.globalAlpha = 0.28;
    paintArch(g);
    g.restore();
    paintArch(g);
    // the surface line, catching what light there is
    g.strokeStyle = "rgba(150,210,220,.3)";
    g.lineWidth = 1.2;
    g.beginPath();
    g.moveTo(LAKE.x0 + 30, S);
    g.lineTo(LAKE.x1 - 30, S);
    g.stroke();
  }

  private paintHall(
    g: Ctx,
    apps: readonly UndercroftApp[],
    t: number,
    lights: Light[],
    inView: (x: number, pad?: number) => boolean,
  ): void {
    const cave = this.cave;
    const beat = heartBeat(t);
    // decorative roots, thick near the heart
    for (let k = 0; k < 26; k++) {
      const rx =
        HALL_X + 60 + ((k * 211) % Math.max(1, cave.hallEnd - HALL_X - 120));
      if (!inView(rx, 200)) continue;
      const len = 80 + ((k * 53) % 160);
      paintRoot(
        g,
        rx,
        ceilY(rx, HALL_X) - 6,
        rx + ((k % 3) - 1) * 30,
        ceilY(rx, HALL_X) + len,
        4 + (k % 4),
      );
    }
    const hy = floorY(cave.heartX) - 110;
    if (inView(cave.heartX, 300)) {
      for (let k = 0; k < 7; k++) {
        const rx = cave.heartX - 240 + k * 80;
        paintRoot(
          g,
          rx,
          ceilY(rx, HALL_X) - 8,
          cave.heartX + (k - 3) * 14,
          hy - 60 + Math.abs(k - 3) * 14,
          12 - Math.abs(k - 3) * 2,
        );
      }
      paintHeart(g, cave.heartX, hy, beat, t, lights);
      // motes rising off it
      for (let i = 0; i < 18; i++) {
        const k = (((t * 0.08 + i * 0.13) % 1) + 1) % 1;
        g.fillStyle = `rgba(255,220,150,${0.6 * Math.sin(k * Math.PI)})`;
        g.fillRect(
          cave.heartX + Math.sin(i * 7.7 + t * 0.3) * 70,
          hy - k * 260,
          1.6,
          1.6,
        );
      }
    }
    // a lantern on a root for every app; a pulse runs out from the heart after it is touched
    cave.lanterns.forEach((L, i) => {
      const app = apps[L.i];
      if (!app || !inView(L.x, 120)) return;
      const p = this.lanternPos(i, t);
      const top = ceilY(L.x, HALL_X) - 8;
      paintRoot(g, L.x + ((i % 3) - 1) * 40, top, p.x, p.y + 2, 5);
      const life = this.host.life(app.id);
      const wave = Math.abs(cave.heartX - L.x) / 900;
      const w = t - this.heartWave - wave;
      const pulse = w > 0 && w < 1 ? Math.sin(w * Math.PI) * 0.6 : 0;
      const near = Math.max(0, 1 - Math.abs(this.hero.x - L.x) / 160) * 0.3;
      const bright = Math.min(1, (life ?? 0.55) * 0.7 + 0.25 + near + pulse);
      paintLantern(g, p.x, p.y, p.swing, app.hue, app.glyph, bright, lights);
    });
  }

  /** The app names under the lanterns the hero stands by or the pointer is on. */
  private paintNames(g: Ctx, apps: readonly UndercroftApp[], t: number): void {
    if (this.doorOpen < 0.9) return;
    g.save();
    g.font = BUBBLE_FONT;
    g.textAlign = "center";
    g.textBaseline = "top";
    this.cave.lanterns.forEach((L, i) => {
      const app = apps[L.i];
      if (!app) return;
      const hov =
        this.hoverThing?.kind === "lantern" && this.hoverThing.i === i;
      const a = hov ? 1 : Math.max(0, 1 - Math.abs(this.hero.x - L.x) / 70);
      if (a <= 0.02) return;
      const p = this.lanternPos(i, t);
      const s = this.toScreen(p.x, p.y + 60);
      g.globalAlpha = a;
      g.fillStyle = "rgba(0,0,0,.55)";
      const w = g.measureText(app.name).width + 14;
      g.beginPath();
      g.roundRect(s.x - w / 2, s.y, w, 20, 10);
      g.fill();
      g.fillStyle = "#ffe9c2";
      g.fillText(app.name, s.x, s.y + 3);
    });
    g.restore();
  }

  private paintTitle(g: Ctx, t: number): void {
    const age = t - this.enteredAt;
    if (age > 9) return;
    const { vw, vh } = this;
    const fade = (a0: number, a1: number, b0: number, b1: number) =>
      Math.max(
        0,
        Math.min(1, (age - a0) / (a1 - a0), 1 - (age - b0) / (b1 - b0)),
      );
    const a = fade(1, 1.8, 5.6, 6.6);
    g.save();
    g.textAlign = "center";
    if (a > 0) {
      g.globalAlpha = a;
      g.fillStyle = "#f4ead2";
      g.font = "600 26px Fraunces";
      g.fillText("The Undercroft", vw / 2, vh * 0.2);
      g.font = "italic 500 15px Fraunces";
      g.fillStyle = "rgba(244,234,210,.75)";
      g.fillText("beneath the well", vw / 2, vh * 0.2 + 24);
    }
    const hint = fade(2, 2.8, 8, 9);
    if (hint > 0) {
      g.globalAlpha = hint;
      g.font = BUBBLE_FONT;
      g.fillStyle = "rgba(230,240,240,.8)";
      g.fillText(
        "← → walk · click what glows · climb the rope or press Esc to go back up",
        vw / 2,
        vh - 28,
      );
    }
    g.restore();
  }
}

const easeIO = (k: number) =>
  k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;

/** `#rrggbb` at an alpha. */
function hexA(hex: string, a: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}
