import type { ChordToken } from "@plugins/apps/plugins/chord/plugins/song-index/core";
import { chordDegree } from "./degree";

// ── Which key on the keyboard answers a chord ────────────────────────────────
//
// The learner presses the number of the chord's root, the way they would read
// it off the page: ♭VII is on the 7 key, ♯IV on the 4 key. The accidental never
// changes the key — only the numeral's number does — so every chord has one,
// and it is the number that picks the chord's colour (`chordDegree`).
//
// Several unlocked chords can share a digit (V and V7 are both a 5). The first
// press then lights that digit's chords, numbered 1…n, and a second key picks
// one. `chordKeyPlan` is that grouping.

/** The key that answers a chord: the numeral's number. */
export type ChordDigit = "1" | "2" | "3" | "4" | "5" | "6" | "7";

const DIGITS = [
  "1",
  "2",
  "3",
  "4",
  "5",
  "6",
  "7",
] as const satisfies readonly ChordDigit[];

/** The key that answers this chord, "1" to "7". Every chord has one. */
export function chordDigit(token: ChordToken): ChordDigit {
  return DIGITS[chordDegree(token)];
}

/** The chords one digit answers, in the order they were given. */
export type ChordKeyGroup = {
  digit: ChordDigit;
  /** At least one. Several means the digit needs a second key to pick. */
  tokens: ChordToken[];
};

/**
 * The unlocked chords grouped by the key that answers them, digits ascending
 * and the chords of a digit in the order `unlocked` gave them (the unlock
 * order, so a new chord joins at the end of its digit).
 *
 * A digit no unlocked chord sits on is left out entirely: pressing it answers
 * nothing.
 */
export function chordKeyPlan(unlocked: readonly ChordToken[]): ChordKeyGroup[] {
  const byDigit = new Map<ChordDigit, ChordToken[]>();
  for (const token of unlocked) {
    const digit = chordDigit(token);
    const group = byDigit.get(digit);
    if (group === undefined) byDigit.set(digit, [token]);
    else group.push(token);
  }
  return [...byDigit.entries()]
    .sort(([a], [b]) => Number(a) - Number(b))
    .map(([digit, tokens]) => ({ digit, tokens }));
}

// ── The second stroke: picking one of a digit's chords ───────────────────────
//
// A digit several chords share needs a second key. With seven chords or fewer
// there is a number for each. Past seven there are no numbers left, so the
// seventh key stops picking and starts PAGING: keys 1–6 pick the six in reach,
// key 7 brings the next six into reach, wrapping at the end. So no chord is
// ever out of reach of the keyboard, however long a digit's list grows.

/** The number keys, in order. Index i is the key that picks the i-th chord. */
const NUMBER_KEYS = [
  "1",
  "2",
  "3",
  "4",
  "5",
  "6",
  "7",
] as const satisfies readonly ChordDigit[];

/** The key that pages, once a digit holds more chords than there are keys. */
const PAGER_KEY = "7" as const satisfies ChordDigit;
/** The pager costs a key, so a page holds one chord fewer than there are keys. */
const PAGE_SIZE = NUMBER_KEYS.length - 1;

/** Which of a digit's chords the second stroke reaches, and the key for the rest. */
export type ChordPick = {
  /** The chord each number key picks right now. Non-empty. */
  numbers: ReadonlyMap<ChordToken, ChordDigit>;
  /** The key that shows the next page, or null when every chord is in reach. */
  pager: ChordDigit | null;
};

/**
 * Which of a digit's chords the second stroke reaches on page `page`, and the
 * key that reaches the rest.
 *
 * `page` counts pages and wraps, so a caller can hold one number and increment
 * it forever; with everything in reach there is one page and `page` changes
 * nothing. Throws on an empty list: a digit with no chords is not in the plan.
 */
export function pickPage(
  tokens: readonly ChordToken[],
  page: number,
): ChordPick {
  if (tokens.length === 0) {
    throw new Error("A digit with no chords answers nothing");
  }
  if (!Number.isInteger(page)) {
    throw new Error(`A page is a whole number, got ${page}`);
  }
  if (tokens.length <= NUMBER_KEYS.length) {
    return { numbers: numberEach(tokens), pager: null };
  }
  const pageCount = Math.ceil(tokens.length / PAGE_SIZE);
  const first = (((page % pageCount) + pageCount) % pageCount) * PAGE_SIZE;
  return {
    numbers: numberEach(tokens.slice(first, first + PAGE_SIZE)),
    pager: PAGER_KEY,
  };
}

/** The chords in reach, each on its own number key, in the order given. */
function numberEach(
  reachable: readonly ChordToken[],
): ReadonlyMap<ChordToken, ChordDigit> {
  const numbers = new Map<ChordToken, ChordDigit>();
  reachable.forEach((token, i) => {
    const key = NUMBER_KEYS[i];
    if (key === undefined) throw new Error(`No number key for chord ${i + 1}`);
    numbers.set(token, key);
  });
  return numbers;
}
