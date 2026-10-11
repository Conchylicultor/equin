import {
  repeatPeriod,
  type ChordToken,
} from "@plugins/apps/plugins/chord/plugins/song-index/core";
import type { Blanks } from "./blanks";

// ── Which boxes wait for an answer ───────────────────────────────────────────
//
// Every box of a round shows a chord or waits for one. Only a PRACTISED chord's
// box can wait; the blanks setting says how many of those do. The rest are
// GIVEN: already showing their chord.

/** What the rule reads of one box of the round (see `trainer/core` `Box`). */
export type AskedBox = {
  /** The box's place in the round, 0-based, in beat order. */
  position: number;
  /** The chord that sounds there. */
  token: ChordToken;
  /** Beats from the window's start to the box's start. */
  gridStart: number;
  /** How many beats the box lasts. */
  gridSpan: number;
};

export type AskedOptions = {
  /** The window's length in beats: `half` splits it down the middle. */
  windowBeats: number;
  blanks: Blanks;
  /** The chords the learner practises: only their boxes can be blank. */
  practised: ReadonlySet<ChordToken>;
  /** `random`'s draw: a number in [0, 1), like `Math.random` (the default). Tests fix it. */
  random?: () => number;
};

/**
 * Which boxes of the round wait for an answer, in beat order. Every other box
 * is given.
 *
 * **A given box never gives an asked one away.** In a loop that replays
 * itself (`repeatPeriod`: I–V–vi–IV twice), the blanks rule below applies to
 * ONE pass, and every replay of an asked box is asked too — otherwise `half`
 * would show the first pass and ask its exact copy. Called once, when the loop is dealt: a `random` draw is not
 * repeated for the same round.
 *
 * - `all`: every practised box;
 * - `first`: every practised box but the round's first box, which is given;
 * - `random`: half of the practised boxes, rounded up, drawn at random;
 * - `half`: every practised box starting at or after the window's midpoint.
 *
 * **Never empty.** A rule that selects nothing — the second half of a loop
 * whose practised chords all sit in its first half, or a loop whose one
 * practised box is its first — falls back to the last practised box. A round with no practised box at all throws: the loop query
 * only returns loops holding a practised chord, so one would mean the round was
 * dealt for a different selection.
 */
export function askedPositions(
  boxes: readonly AskedBox[],
  opts: AskedOptions,
): number[] {
  if (!(Number.isFinite(opts.windowBeats) && opts.windowBeats > 0)) {
    throw new Error(
      `askedPositions: a window lasts a positive number of beats, got ${opts.windowBeats}`,
    );
  }
  const byBeat = [...boxes].sort((a, b) => a.position - b.position);
  const period = repeatPeriod(
    byBeat.map((box) => ({
      start: box.gridStart,
      end: box.gridStart + box.gridSpan,
      token: box.token,
    })),
    opts.windowBeats,
  );
  // Every pass holds the same boxes, so a box's place in its pass is its
  // index modulo the pass's length.
  const perPass = byBeat.length / Math.round(opts.windowBeats / period);
  const firstPass = byBeat.slice(0, perPass);
  const askedInPass = new Set(
    askedInOnePass(firstPass, period, opts).map((box) =>
      firstPass.indexOf(box),
    ),
  );
  return byBeat
    .filter((_, i) => askedInPass.has(i % perPass))
    .map((box) => box.position);
}

/** The blanks rule over one pass of `windowBeats` beats. Never empty. */
function askedInOnePass(
  boxes: readonly AskedBox[],
  windowBeats: number,
  opts: AskedOptions,
): AskedBox[] {
  const practised = boxes.filter((box) => opts.practised.has(box.token));
  const last = practised.at(-1);
  if (last === undefined) {
    throw new Error(
      "askedPositions: the round holds no practised chord, so nothing can be asked",
    );
  }

  let selected: AskedBox[];
  switch (opts.blanks) {
    case "all":
      selected = practised;
      break;
    case "first":
      selected = practised.filter((box) => box !== boxes[0]);
      break;
    case "random":
      selected = drawHalf(practised, opts.random ?? Math.random);
      break;
    case "half":
      selected = practised.filter((box) => box.gridStart >= windowBeats / 2);
      break;
  }

  return selected.length === 0 ? [last] : selected;
}

/** Half of `boxes`, rounded up, drawn without replacement (a partial Fisher–Yates). */
function drawHalf(
  boxes: readonly AskedBox[],
  random: () => number,
): AskedBox[] {
  const pool = boxes.slice();
  const count = Math.ceil(pool.length / 2);
  for (let i = 0; i < count; i++) {
    const j = i + Math.floor(random() * (pool.length - i));
    const at = pool[i];
    const picked = pool[j];
    if (at === undefined || picked === undefined) {
      throw new Error(
        `drawHalf: the draw ${j} fell outside the ${pool.length} boxes`,
      );
    }
    pool[i] = picked;
    pool[j] = at;
  }
  return pool.slice(0, count);
}
