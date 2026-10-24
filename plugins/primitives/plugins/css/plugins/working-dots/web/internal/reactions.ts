/**
 * How the dots answer a poke, as pure data: each reaction is a list of kicks
 * to the dots' jolt springs (velocity in shape units per second, a scale
 * velocity, an optional delay), so a reaction plays out over a moment and
 * the springs carry every dot home with a jiggle.
 */

export interface Kick {
  /** Delay from the poke, in ms. */
  at: number;
  dot: number;
  vx: number;
  vy: number;
  /** Scale velocity. */
  vs: number;
}

/** Each dot's unit way out, away from the finger. */
export type Away = readonly (readonly [number, number])[];

export type ReactionName =
  "scatter" | "hop" | "gulp" | "shiver" | "bolt" | "spin";

export interface Reaction {
  /** Relative chance of being drawn. */
  weight: number;
  /** Whether the next move is the ring, straight away. */
  ring?: boolean;
  /** `m` scales the reaction (excitement); `hit` is the dot nearest the finger. */
  kicks: (away: Away, m: number, hit: number) => Kick[];
}

const DOTS = [0, 1, 2] as const;
const kick = (
  at: number,
  dot: number,
  vx: number,
  vy: number,
  vs = 0,
): Kick => ({
  at,
  dot,
  vx,
  vy,
  vs,
});

export const REACTIONS: Record<ReactionName, Reaction> = {
  // Scatter away from the finger.
  scatter: {
    weight: 3,
    kicks: (away, m) =>
      away.map(([ux, uy], i) => {
        const side = (Math.random() - 0.5) * 40;
        return kick(
          0,
          i,
          ux * 95 * m - uy * side,
          uy * 95 * m + ux * side - 25,
          3,
        );
      }),
  },
  // Jump, one after another, and land with a squash.
  hop: {
    weight: 3,
    kicks: (_, m) =>
      DOTS.flatMap((i) => [
        kick(i * 70, i, 0, -105 * m, -1.5),
        kick(i * 70 + 240, i, 0, 0, -4),
      ]),
  },
  // Flinch into one blob in the middle (the goo melts them together), then pop apart.
  gulp: {
    weight: 2,
    kicks: (_, m) => [
      kick(0, 0, 120 * m, 0, -2),
      kick(0, 2, -120 * m, 0, -2),
      kick(0, 1, 0, 0, -3),
      kick(230, 0, -55 * m, -10, 4),
      kick(230, 2, 55 * m, -10, 4),
      kick(230, 1, 0, -45 * m, 4),
    ],
  },
  // A shiver runs through the row, fading.
  shiver: {
    weight: 2,
    kicks: (_, m) =>
      [0, 1, 2, 3, 4, 5].flatMap((k) =>
        DOTS.map((i) =>
          kick(
            k * 55 + i * 18,
            i,
            (k % 2 ? -1 : 1) * 55 * m * (1 - k / 7),
            (Math.random() - 0.5) * 20,
          ),
        ),
      ),
  },
  // The dot you poked bolts; the others start a beat after it.
  bolt: {
    weight: 2,
    kicks: (away, m, hit) =>
      away.map(([ux, uy], i) =>
        i === hit
          ? kick(0, i, ux * 150 * m, uy * 150 * m - 30, 2)
          : kick(110, i, ux * 35 * m, uy * 35 * m - 15, 1),
      ),
  },
  // Whirl off into the ring.
  spin: {
    weight: 1.5,
    ring: true,
    kicks: (away) => away.map(([ux, uy], i) => kick(0, i, ux * 35, uy * 35, 3)),
  },
};

const REACTION_NAMES = Object.keys(REACTIONS) as ReactionName[];

/** A reaction drawn by weight, never `last` again. */
export function pickReaction(last: ReactionName | null): ReactionName {
  const pool = REACTION_NAMES.filter((n) => n !== last);
  let r = Math.random() * pool.reduce((t, n) => t + REACTIONS[n].weight, 0);
  for (const n of pool) if ((r -= REACTIONS[n].weight) <= 0) return n;
  return pool[pool.length - 1]!;
}
