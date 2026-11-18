/**
 * The chord-body **modifier grammar** — the alteration/extension tail shared by
 * both chord-authoring parsers.
 *
 * A chord body is `[base head][modifier tail]`: the head names a canonical
 * `quality` (seeding a degree→semitone map) and the tail mutates that map by
 * scale degree — suspensions (`sus2`/`sus4`), omissions (`no3`/`omit5`), added
 * tones (`add9`, or a bare tension `6`/`9`/`11`/`13`), and altered tones (`♯5`,
 * `♭9`, …). Any combination composes, so the grammar scales to stacked
 * alterations that a fixed table never could.
 *
 * The *head* differs between the two parsers — a letter name (`Cmaj7`, `parse.ts`)
 * vs a Roman numeral whose case carries the triad quality (`Imaj7`, `roman.ts`) —
 * so each owns its head resolution. But the *tail* is identical, so it lives
 * here: `applyModifierTail(quality, rest)` seeds from `SEED[quality]`, applies
 * every modifier, and returns the realised intervals + canonical suffix (or
 * `null` when the tail has unrecognised trailing text — a typo).
 *
 * Pure TypeScript, no imports beyond the sibling chord vocabulary — a leaf both
 * parsers depend on, keeping the theory DAG acyclic.
 */

/**
 * Seed degree→semitone map per base quality (scale degree → semitones above the
 * root). Modifiers mutate this by degree. Kept consistent with `CHORD_TEMPLATES`
 * in chords.ts — the values equal that quality's interval set — so an unmodified
 * head realises exactly the template (though a plain head leaves `intervals`
 * absent and derives from `quality` directly).
 */
export const SEED: Record<string, ReadonlyArray<readonly [number, number]>> = {
  maj: [[3, 4], [5, 7]],
  min: [[3, 3], [5, 7]],
  aug: [[3, 4], [5, 8]],
  dim: [[3, 3], [5, 6]],
  maj7: [[3, 4], [5, 7], [7, 11]],
  dom7: [[3, 4], [5, 7], [7, 10]],
  min7: [[3, 3], [5, 7], [7, 10]],
  minmaj7: [[3, 3], [5, 7], [7, 11]],
  halfdim7: [[3, 3], [5, 6], [7, 10]],
  dim7: [[3, 3], [5, 6], [7, 9]],
  augmaj7: [[3, 4], [5, 8], [7, 11]],
  aug7: [[3, 4], [5, 8], [7, 10]],
  maj6: [[3, 4], [5, 7], [6, 9]],
  min6: [[3, 3], [5, 7], [6, 9]],
  maj9: [[3, 4], [5, 7], [7, 11], [9, 14]],
  dom9: [[3, 4], [5, 7], [7, 10], [9, 14]],
  min9: [[3, 3], [5, 7], [7, 10], [9, 14]],
  dom13: [[3, 4], [5, 7], [7, 10], [9, 14], [13, 21]],
  sus2: [[2, 2], [5, 7]],
  sus4: [[4, 5], [5, 7]],
  six9: [[3, 4], [5, 7], [6, 9], [9, 14]],
};

/** Natural (unaltered) semitone for a scale degree. Alterations offset this. */
const NATURAL_DEGREE: Record<number, number> = {
  2: 2,
  3: 4,
  4: 5,
  5: 7,
  6: 9,
  7: 10,
  9: 14,
  11: 17,
  13: 21,
};

type Modifier =
  | { kind: "sus"; deg: 2 | 4; len: number }
  | { kind: "omit"; deg: number; len: number }
  | { kind: "add"; deg: number; len: number }
  | { kind: "alt"; deg: number; acc: 1 | -1; len: number };

/**
 * One modifier token at the start of `rest`. Suspensions (`sus2`/`sus4`/`sus`),
 * omissions (`no3`/`omit5`), added tones (`add9`, or a bare natural tension
 * `6`/`9`/`11`/`13`), and altered tones (an accidental — `#`/`♯`/`+` sharp,
 * `b`/`♭`/`-` flat — before a degree). Bare `2`/`4`/`5` are intentionally NOT
 * added tones (`2`/`4` are the domain of `sus`; a bare `5` is ambiguous).
 */
const MODIFIER =
  /^(?:sus2|sus4|sus|(?:no|omit)(3|5)|add(2|4|6|9|11|13)|([+#♯b♭-])(2|4|5|6|9|11|13)|(6|9|11|13))/;

/**
 * The modifier words, which read the same in any case (`Sus4`, `Add9`, `No3`).
 * Folded on their own rather than with an `i` flag on `MODIFIER`, which would
 * also let a capital `B` pass for the flat accidental `b`.
 */
const MODIFIER_WORD = /^(?:sus|add|omit|no)/i;

function matchModifier(rest: string): Modifier | null {
  const m = MODIFIER.exec(rest.replace(MODIFIER_WORD, (w) => w.toLowerCase()));
  if (!m) return null;
  const len = m[0].length;
  if (m[0] === "sus2") return { kind: "sus", deg: 2, len };
  if (m[0] === "sus4" || m[0] === "sus") return { kind: "sus", deg: 4, len };
  if (m[1]) return { kind: "omit", deg: Number(m[1]), len };
  if (m[2]) return { kind: "add", deg: Number(m[2]), len };
  if (m[3]) {
    const acc = m[3] === "+" || m[3] === "#" || m[3] === "♯" ? 1 : -1;
    return { kind: "alt", deg: Number(m[4]), acc, len };
  }
  if (m[5]) return { kind: "add", deg: Number(m[5]), len };
  return null;
}

/** Mutate the degree→semitone map by one modifier. */
function applyModifier(degrees: Map<number, number>, mod: Modifier): void {
  switch (mod.kind) {
    case "sus":
      degrees.delete(3);
      degrees.set(mod.deg, mod.deg === 2 ? 2 : 5);
      break;
    case "omit":
      degrees.delete(mod.deg);
      break;
    case "add":
      degrees.set(mod.deg, NATURAL_DEGREE[mod.deg]!);
      break;
    case "alt":
      degrees.set(mod.deg, NATURAL_DEGREE[mod.deg]! + mod.acc);
      break;
  }
}

/**
 * Canonical suffix for the modifier list, appended after the head suffix:
 * `sus2`/`sus4` first, then all altered tones grouped in a single degree-sorted
 * `(♯5♭9)`, then `addN`, then `(noN)`. E.g. `[alt ♯5]` → `"(♯5)"`, `[sus4, alt
 * ♭9]` → `"sus4(♭9)"`.
 */
function formatModifiers(mods: readonly Modifier[]): string {
  let out = "";
  const sus = mods.find((m) => m.kind === "sus");
  if (sus) out += sus.deg === 2 ? "sus2" : "sus4";

  const alts = mods
    .filter((m): m is Extract<Modifier, { kind: "alt" }> => m.kind === "alt")
    .sort((a, b) => a.deg - b.deg);
  if (alts.length > 0) {
    out += "(" + alts.map((a) => (a.acc > 0 ? "♯" : "♭") + a.deg).join("") + ")";
  }

  const adds = mods
    .filter((m) => m.kind === "add")
    .sort((a, b) => a.deg - b.deg);
  for (const a of adds) out += "add" + a.deg;

  const omits = mods
    .filter((m) => m.kind === "omit")
    .sort((a, b) => a.deg - b.deg);
  for (const o of omits) out += "(no" + o.deg + ")";

  return out;
}

/** The realised body of a chord once its modifier tail is applied. */
export interface ModifierTail {
  /** Realised interval set, or `null` when there were no modifiers (plain head). */
  intervals: number[] | null;
  /** Canonical modifier suffix (e.g. `"(♭9)"`, `"sus4(♯5)"`), empty when none. */
  modSuffix: string;
}

/**
 * Apply the modifier tail `rest` to a base `quality`, returning the realised
 * intervals (only when actually altered — a plain quality returns `null` so the
 * caller derives pitches from `quality`) and the canonical modifier suffix.
 *
 * Returns `null` when `rest` has any unrecognised trailing text — the whole
 * chord is then a typo — so callers surface it rather than silently dropping it.
 *
 * `separators` between modifiers (whitespace, commas, the `(` `)` that wrap
 * `(♭9)`) are skipped, so both `"7♭9"` and `"7(♭9)"` parse identically.
 */
export function applyModifierTail(
  quality: string,
  rest: string,
): ModifierTail | null {
  const degrees = new Map<number, number>(SEED[quality]);
  const mods: Modifier[] = [];

  let r = rest;
  while (r.length > 0) {
    const sep = /^[\s,()]+/.exec(r);
    if (sep) {
      r = r.slice(sep[0].length);
      continue;
    }
    const mod = matchModifier(r);
    if (!mod) return null; // unrecognised trailing text → typo.
    applyModifier(degrees, mod);
    mods.push(mod);
    r = r.slice(mod.len);
  }

  const intervals =
    mods.length === 0
      ? null
      : Array.from(new Set(degrees.values())).sort((a, b) => a - b);
  return { intervals, modSuffix: formatModifiers(mods) };
}
