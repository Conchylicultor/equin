// The Undercroft's geography, as pure data: one long cavern seen from the
// side, read left to right — the Wishing Pool under the well's shaft, the
// Glowcap Grove, the Mirror Lake crossed on a stone arch, the Keeper's ledge,
// the Crystal Choir and its sealed round door, and past it the Root Hall,
// where the island's roots come down holding a lantern for every app, round
// the island's heart. Deterministic from the number of apps (the hall grows a
// bay per app), so the same island always has the same cave.

import { seeded, type Rnd } from "../kit";

/** The cave's height (world px): the camera fits it to the view. */
export const CAVE_H = 600;
/** Where the shaft comes down, and the rope with it. */
export const SHAFT_X = 380;
export const SHAFT_TOP = 64;
export const ROPE_END = 420;

export const POOL = { x0: 230, x1: 540, surface: 476 } as const;
export const LAKE = { x0: 1740, x1: 2660, surface: 506 } as const;
/** The stone arch the path crosses the lake on. */
export const ARCH = { x0: 1760, x1: 2640, rise: 74 } as const;
export const KEEPER_X = 2860;
/** The crystals, left to right; each sings one note of a pentatonic scale. */
export const CRYSTAL_NOTES = [72, 74, 76, 79, 81, 84] as const;
export const CRYSTAL_HUES = [205, 15, 120, 50, 310, 265] as const;
export const CRYSTAL_X0 = 3080;
export const CRYSTAL_DX = 150;
/** The song painted on the wall — crystal indices. Not a walk past them either way. */
export const SONG = [2, 3, 4, 3, 0] as const;
export const MURAL_X = 3430;
export const DOOR_X = 4060;
export const DOOR_R = 74;
/** The hall starts past the door; each app hangs a lantern a bay apart. */
export const HALL_X = DOOR_X + 120;
const BAY = 130;

export type ZoneName =
  | "Wishing Pool"
  | "Glowcap Grove"
  | "Mirror Lake"
  | "Keeper's Ledge"
  | "Crystal Choir"
  | "Root Hall";

export interface Zone {
  readonly name: ZoneName;
  readonly x0: number;
}

export interface Mushroom {
  readonly x: number;
  readonly h: number;
  readonly r: number;
  readonly hue: number;
  readonly lean: number;
  /** Drawn in front of the hero (the near row). */
  readonly front: boolean;
  readonly ph: number;
}

export interface Thread {
  readonly x: number;
  readonly len: number;
  readonly ph: number;
}

export interface Coin {
  readonly x: number;
  readonly y: number;
  readonly wish: number;
}

export interface Spike {
  readonly x: number;
  readonly w: number;
  readonly h: number;
}

export interface Lantern {
  /** Index into the apps as handed over. */
  readonly i: number;
  readonly x: number;
  /** Where the root holding it ends. */
  readonly y: number;
  readonly sway: number;
}

export interface Cave {
  readonly width: number;
  readonly hallEnd: number;
  readonly heartX: number;
  readonly zones: readonly Zone[];
  readonly mushrooms: readonly Mushroom[];
  readonly threads: readonly Thread[];
  readonly coins: readonly Coin[];
  readonly stalactites: readonly Spike[];
  readonly stalagmites: readonly Spike[];
  readonly lanterns: readonly Lantern[];
  readonly crystals: readonly number[];
  /** Far rock silhouettes (parallax 0.35): [x, half width, height from the floor line]. */
  readonly far: readonly (readonly [number, number, number])[];
}

const archY = (x: number): number =>
  -ARCH.rise * Math.sin((Math.PI * (x - ARCH.x0)) / (ARCH.x1 - ARCH.x0));

/** The ground line the hero walks on (the arch's top over the lake). */
export function floorY(x: number): number {
  const base = 474 + 9 * Math.sin(x / 170) + 5 * Math.sin(x / 61 + 1.3);
  if (x > POOL.x0 - 60 && x < POOL.x1 + 60) {
    // a shallow basin under the shaft: the pool's water stands over it
    const k = Math.min(1, Math.min(x - (POOL.x0 - 60), POOL.x1 + 60 - x) / 60);
    const mid = (POOL.x0 + POOL.x1) / 2;
    const half = (POOL.x1 - POOL.x0) / 2 + 20;
    const dip = 16 * Math.max(0, 1 - ((x - mid) / half) ** 2);
    return base + (472 - base) * k + dip;
  }
  if (x >= ARCH.x0 && x <= ARCH.x1) return 470 + archY(x);
  if (x > ARCH.x0 - 80 && x < ARCH.x0)
    return base + (470 - base) * ((x - (ARCH.x0 - 80)) / 80);
  if (x > ARCH.x1 && x < ARCH.x1 + 80)
    return 470 + (base - 470) * ((x - ARCH.x1) / 80);
  return base;
}

/** The rock floor itself: what lies under the lake and the arch. */
export function bedY(x: number): number {
  if (x > LAKE.x0 && x < LAKE.x1) {
    const k = Math.min(1, Math.min(x - LAKE.x0, LAKE.x1 - x) / 60);
    return floorY(x) * (1 - k) + (CAVE_H + 20) * k;
  }
  return floorY(x);
}

/** The ceiling's underside. */
export function ceilY(x: number, hallX: number): number {
  const base = 96 + 34 * Math.sin(x / 230) + 18 * Math.sin(x / 97 + 2);
  const shaft = Math.abs(x - SHAFT_X);
  const s = shaft < 120 ? (1 - shaft / 120) * 30 : 0;
  // the hall's vault rises high
  const hall = x > hallX - 100 ? Math.min(1, (x - hallX + 100) / 200) * 54 : 0;
  return base - s - hall;
}

export function makeCave(apps: number): Cave {
  const rnd: Rnd = seeded(0x5e11);
  const hallLen = Math.max(1100, apps * BAY + 640);
  const hallEnd = HALL_X + hallLen;
  const heartX = hallEnd - 230;
  const width = hallEnd + 40;
  const zones: Zone[] = [
    { name: "Wishing Pool", x0: 0 },
    { name: "Glowcap Grove", x0: 760 },
    { name: "Mirror Lake", x0: LAKE.x0 },
    { name: "Keeper's Ledge", x0: LAKE.x1 },
    { name: "Crystal Choir", x0: CRYSTAL_X0 - 120 },
    { name: "Root Hall", x0: DOOR_X + 40 },
  ];

  const mushrooms: Mushroom[] = [];
  const grove: [number, number] = [740, 1640];
  for (let i = 0; i < 34; i++) {
    const front = i % 4 === 3;
    const x = grove[0] + rnd() * (grove[1] - grove[0]);
    const big = rnd() < 0.22 && !front;
    mushrooms.push({
      x,
      h: front ? 14 + rnd() * 22 : big ? 80 + rnd() * 70 : 16 + rnd() * 40,
      r: front ? 10 + rnd() * 10 : big ? 30 + rnd() * 24 : 8 + rnd() * 14,
      hue: [186, 286, 168, 36][(rnd() * 4) | 0]!,
      lean: (rnd() - 0.5) * 0.35,
      front,
      ph: rnd() * 6.28,
    });
  }
  // a few strays: by the pool, on the lake shores, at the hall's door
  for (const x of [90, 610, 680, 1690, 2720, 2790, 3000, 3900])
    mushrooms.push({
      x: x + rnd() * 30,
      h: 12 + rnd() * 20,
      r: 7 + rnd() * 8,
      hue: [186, 286][(rnd() * 2) | 0]!,
      lean: (rnd() - 0.5) * 0.3,
      front: false,
      ph: rnd() * 6.28,
    });
  mushrooms.sort((a, b) => b.h - a.h);

  const threads: Thread[] = [];
  for (let x = 700; x < CRYSTAL_X0 - 80; x += 10 + rnd() * 26)
    if (Math.abs(x - SHAFT_X) > 140)
      threads.push({ x, len: 18 + rnd() * rnd() * 140, ph: rnd() * 6.28 });

  const coins: Coin[] = [];
  for (let i = 0; i < 14; i++) {
    const x = POOL.x0 + 40 + rnd() * (POOL.x1 - POOL.x0 - 80);
    // lying on the pool's floor, under the water
    coins.push({ x, y: floorY(x) - 1 - rnd() * 3, wish: i });
  }

  const stalactites: Spike[] = [];
  for (let x = 30; x < width - 30; x += 40 + rnd() * 90)
    if (Math.abs(x - SHAFT_X) > 90 && Math.abs(x - DOOR_X) > 120)
      stalactites.push({ x, w: 8 + rnd() * 16, h: 20 + rnd() * rnd() * 90 });
  const stalagmites: Spike[] = [];
  for (const x of [1820, 1990, 2210, 2350, 2560])
    stalagmites.push({
      x: x + rnd() * 40,
      w: 14 + rnd() * 16,
      h: 40 + rnd() * 70,
    });

  const lanterns: Lantern[] = [];
  const span = heartX - 200 - (HALL_X + 180);
  for (let i = 0; i < apps; i++) {
    const x = HALL_X + 180 + (apps > 1 ? (span * i) / (apps - 1) : span / 2);
    lanterns.push({
      i,
      x,
      y: 200 + (i % 3) * 52 + rnd() * 30,
      sway: rnd() * 6.28,
    });
  }

  const crystals = CRYSTAL_NOTES.map((_, i) => CRYSTAL_X0 + i * CRYSTAL_DX);

  const far: [number, number, number][] = [];
  for (let x = -200; x < width * 0.4 + 900; x += 120 + rnd() * 160)
    far.push([x, 60 + rnd() * 120, 120 + rnd() * 220]);

  return {
    width,
    hallEnd,
    heartX,
    zones,
    mushrooms,
    threads,
    coins,
    stalactites,
    stalagmites,
    lanterns,
    crystals,
    far,
  };
}

/** The zone a point of the cave is in. */
export function zoneAt(cave: Cave, x: number): ZoneName {
  let z = cave.zones[0]!.name;
  for (const s of cave.zones) if (x >= s.x0) z = s.name;
  return z;
}

/** Wishes thrown into the well, found as coins in the pool below. */
export const WISHES = [
  "“I wish the build would go green the first time.”",
  "“I wish for one more hour of sleep. Just one.”",
  "“I wish someone would finish the bridge to the far island.”",
  "“I wish my agents would stop arguing about tabs.”",
  "“I wish to see the werewolf. From a safe distance.”",
  "“I wish the bats would learn a second song.”",
  "“I wish my todo list were shorter than my done list.”",
  "“I wish for a boat. A small one. With a bell.”",
  "“I wish the campfire never went out.”",
  "“I wish whoever finds this a very good day.”",
  "“I wish to know what is under the well.” — well, here you are.",
  "“I wish for an app that waters the plants.”",
  "“I wish the gulls would give my sandwich back.”",
  "“I wish this island never stops growing.”",
] as const;

/** What the Keeper says, a line each time it is spoken to; the last repeats. */
export const KEEPER_LINES = [
  "…mm? Oh. A visitor from up there.",
  "Few find the well. Fewer jump in.",
  "Everything the island forgets drifts down here to me.",
  "The crystals remember an old song. It is painted on the wall, past the water.",
  "Play it true, and the round door will remember how to open.",
  "Go on. I'll keep the lake still for you.",
] as const;

export const KEEPER_SOLVED = [
  "You played it. I felt the roots stir from here.",
  "Every house up there has a root down here. Go and see.",
] as const;
