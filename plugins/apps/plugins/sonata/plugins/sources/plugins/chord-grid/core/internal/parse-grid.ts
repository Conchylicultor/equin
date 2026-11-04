/**
 * Chord-grid mini-language parser: grid text → timed chord events.
 *
 * The grammar is deliberately small — three things:
 *
 *   - a **chord** (`Cmaj7`, `F#m`, `Bb13`, `G7(♯5)`) occupies one bar. A chord
 *     may carry parenthetical alterations *attached* to it (no space) — these
 *     are absorbed into the token, so they are never mistaken for a group. A
 *     chord may equally be written as a **Roman numeral** (`I`, `vi`, `V7`,
 *     `iiø7`, `♭VII`), resolved against the key in force — a *degree*, not a
 *     letter, so a progression can be written once and heard in any key;
 *   - a **group** `( … )` — a `(` at a cell boundary — puts several items in a
 *     single bar, splitting it equally between them;
 *   - a **hold** `.` extends the previous chord instead of striking a new one.
 *
 * Plus two pieces of trivia that consume no bar:
 *
 *   - a `;` starts a comment that runs to the end of the line (`; verse`);
 *     comments are blanked before tokenizing. `;` is deliberately NOT a musical
 *     character, so it needs no positional rule to disambiguate — unlike `#`,
 *     which it replaced: `#` is the sharp, and a degree may legally *begin* with
 *     one (`♯IV`), so no position was ever safely free for it;
 *   - a `key: Am` **directive** sets the key that Roman numerals resolve
 *     against, from that point forward (so a grid may modulate). Absent any
 *     directive the key is C major, and letter-name chords never consult it.
 *
 * Cells are separated by whitespace / newlines (newlines are purely cosmetic),
 * and a stray `|` is accepted and ignored so old `| C G | Am F |` grids keep
 * parsing. Each top-level cell is one bar (`BEATS_PER_BAR` quarter-note beats).
 *
 * `.` holds work the same way at both levels: inside a group it eats one
 * sub-slot of that bar (`(C . . D)` → C for 3 beats + D for 1), and at the top
 * level it eats a whole bar (`Cmaj7 . .` → one Cmaj7 sustained across 3 bars).
 * A hold extends whatever chord last sounded, even across a bar boundary; a hold
 * with nothing before it (grid start, or after an unparseable token) is silence.
 *
 * Unparseable tokens never crash — they are collected into `skipped` and
 * surfaced by the loader, so typos stay visible rather than silently dropped.
 *
 * The parse also returns `tokens` — a classified span over the source text for
 * every meaningful piece (chord, degree, hold, group parens, comment, key
 * directive) — which the editor colours. A span is `invalid` exactly when its
 * text went into `skipped`: both are written by the one `Marks.reject` call
 * inside the same expansion, so the highlight and the compiler cannot disagree.
 */

import type { KeySignature } from "@plugins/apps/plugins/sonata/plugins/score/core";
import {
  parseChordSymbol,
  parseKeySignature,
  parseRomanNumeral,
} from "@plugins/apps/plugins/sonata/plugins/theory/core";
import { type ChordEvent } from "@plugins/apps/plugins/sonata/plugins/voicing/core";

/** Default bar length in quarter-note beats (4/4). */
const BEATS_PER_BAR = 4;

/** The hold marker: extends the previous chord rather than striking a new one. */
const HOLD = ".";

/** The comment marker. Not a musical character, so it means this and nothing else. */
const COMMENT = ";";

/**
 * The key Roman numerals resolve against until a `key:` directive says otherwise.
 * C major is the neutral choice: its degrees are the plain white keys, so an
 * undeclared `I vi IV V` reads C Am F G — and the transpose control moves it.
 */
export const DEFAULT_KEY: KeySignature = { tonic: "C", mode: "major" };

/**
 * A `key:` / `key=` directive opening a cell, with the tonic attached (`key:Am`)
 * or left for the next cell (`key: Am`). `key` is not a chord symbol, so nothing
 * legal is shadowed.
 */
const KEY_DIRECTIVE = /^key[:=](.*)$/i;

/** A key change established at a beat — the grid's authored key context. */
export interface KeyChange {
  beat: number;
  key: KeySignature;
}

/**
 * What a span of the grid text is, for the editor's colouring. `invalid` is
 * written only by `reject`, the same call that fills `skipped`.
 */
export type GridTokenKind =
  | "chord"
  | "degree"
  | "hold"
  | "group-open"
  | "group-close"
  | "comment"
  | "key-directive"
  | "key-value"
  | "invalid";

/** A classified span `[from, to)` of the grid text (UTF-16 offsets). */
export interface GridToken {
  from: number;
  to: number;
  kind: GridTokenKind;
}

/** The result of parsing a grid. */
export interface ParsedGrid {
  events: ChordEvent[];
  /** Unparseable tokens, in source order per stage; never silently dropped. */
  skipped: string[];
  keys: KeyChange[];
  /** Classified spans over the source text, sorted by `from`, non-overlapping. */
  tokens: GridToken[];
  /** Bars the grid occupies — one per top-level cell. */
  bars: number;
}

interface Span {
  from: number;
  to: number;
}

/** A bare token with the span it was read from. */
interface Item {
  token: string;
  span: Span;
}

/** A tokenized cell: a chord, a parenthesised group, a hold, or a key directive. */
type Cell =
  | { kind: "chord"; item: Item }
  | { kind: "group"; open: Span; close: Span; items: Item[] }
  | { kind: "hold"; span: Span }
  | { kind: "key"; arg: string; directive: Span; value: Span | null };

/**
 * The parse's two outputs that describe the source text — the span colouring
 * and the typo list — written together, so a span is `invalid` exactly when
 * its text was skipped.
 */
class Marks {
  readonly tokens: GridToken[] = [];
  readonly skipped: string[] = [];

  mark(span: Span, kind: GridTokenKind): void {
    if (span.to > span.from) this.tokens.push({ ...span, kind });
  }

  /** Record `token` as skipped and paint every one of its spans invalid. */
  reject(token: string, ...spans: Span[]): void {
    this.skipped.push(token);
    for (const span of spans) this.mark(span, "invalid");
  }
}

/**
 * The insignificant characters: whitespace and the optional `|` bar separator.
 * They separate cells and carry no meaning of their own — unlike `(`, `)` and
 * `.`, which are part of the grammar.
 */
function isInsignificant(c: string): boolean {
  return c === " " || c === "\t" || c === "\n" || c === "\r" || c === "|";
}

/**
 * Blank out line comments — lexical trivia, replaced by spaces before
 * tokenizing so `(` groups, chord runs and holds never have to know about them.
 * Blanking (not deleting) keeps every offset equal to the source's, so the
 * spans the tokenizer reads are spans of the text the user typed. The
 * terminating newline survives, so a comment can't glue two lines into one cell.
 *
 * `;` carries no musical meaning, so a comment starts wherever one appears —
 * there is nothing to disambiguate against, and no position clause to remember.
 */
function blankComments(text: string, marks: Marks): string {
  let out = "";
  let i = 0;
  const n = text.length;
  while (i < n) {
    if (text[i] === COMMENT) {
      const from = i;
      while (i < n && text[i] !== "\n") i++;
      marks.mark({ from, to: i }, "comment");
      out += " ".repeat(i - from);
      continue;
    }
    out += text[i]!;
    i++;
  }
  return out;
}

/** Characters that end a bare chord run (whitespace, group/bar/hold markers). */
function isBoundary(c: string): boolean {
  return isInsignificant(c) || c === "(" || c === ")" || c === HOLD;
}

/**
 * Read one bare run starting at `start` — a chord token or a directive — up to
 * the next boundary, absorbing any parentheses ATTACHED to it (no preceding
 * space): a parenthetical alteration like `G7(♯5)` or `Gsus4(♭9)`. A grouping
 * `( … )` only ever opens at a cell boundary (handled by the caller), so a `(`
 * reached mid-run belongs to the chord, not a group.
 */
function readRun(text: string, start: number): { token: string; next: number } {
  const n = text.length;
  let i = start;
  let token = "";
  while (i < n) {
    const ch = text[i]!;
    if (ch === "(") {
      // Absorb a balanced (…) alteration group, parens included.
      let depth = 0;
      while (i < n) {
        const d = text[i]!;
        token += d;
        i++;
        if (d === "(") depth++;
        else if (d === ")") {
          depth--;
          if (depth === 0) break;
        }
      }
    } else if (isBoundary(ch)) {
      break;
    } else {
      token += ch;
      i++;
    }
  }
  return { token, next: i };
}

/** The whitespace-separated items of `text`, each with its span offset by `base`. */
function itemsOf(text: string, base: number): Item[] {
  return [...text.matchAll(/\S+/g)].map((m) => ({
    token: m[0],
    span: { from: base + m.index, to: base + m.index + m[0].length },
  }));
}

/** Char-scan the (comment-blanked) grid text into cells (groups contain spaces, so no naive split). */
function tokenize(text: string, marks: Marks): Cell[] {
  const cells: Cell[] = [];
  let i = 0;
  const n = text.length;

  while (i < n) {
    const c = text[i]!;

    // Whitespace and the optional `|` bar separator are insignificant.
    if (isInsignificant(c)) {
      i++;
      continue;
    }

    if (c === ")") {
      marks.reject(")", { from: i, to: i + 1 }); // stray closer with no open group
      i++;
      continue;
    }

    if (c === "(") {
      // A `(` at a cell boundary opens a bar group. Read to its matching close
      // at depth 0 — depth-aware so a chord's own alteration parens inside the
      // group (e.g. `(G7(♯5) A)`) don't end the group early.
      const start = i;
      i++;
      let body = "";
      let closed = false;
      let depth = 1;
      while (i < n) {
        const d = text[i]!;
        if (d === "(") depth++;
        else if (d === ")") {
          depth--;
          if (depth === 0) {
            closed = true;
            i++;
            break;
          }
        }
        body += d;
        i++;
      }
      if (!closed) {
        // Unterminated group: the whole rest is one typo — the `(` and every
        // run after it (the blanked comments in between stay comments).
        const rest = text.slice(start);
        marks.reject(
          rest.replace(/\s+/g, " ").trim(),
          ...itemsOf(rest, start).map((it) => it.span),
        );
        break;
      }
      // Group items are whitespace-separated; a chord's own `(…)` has no inner
      // space, so `G7(♯5)` stays one item.
      cells.push({
        kind: "group",
        open: { from: start, to: start + 1 },
        close: { from: i - 1, to: i },
        items: itemsOf(body, start + 1),
      });
      continue;
    }

    if (c === HOLD) {
      cells.push({ kind: "hold", span: { from: i, to: i + 1 } });
      i++;
      continue;
    }

    const start = i;
    const run = readRun(text, i);
    i = run.next;

    // A `key:` / `key=` directive. The tonic may be attached (`key:Am`) or sit
    // in the next cell (`key: Am`) — the friendlier spelling, so we look ahead
    // past the insignificant characters for it. A directive with no tonic at all
    // falls through with an empty arg and is reported as a typo by `expand`.
    const directive = KEY_DIRECTIVE.exec(run.token);
    if (directive) {
      let arg = directive[1]!;
      // `key` plus its `:` / `=` — the rest of an attached run is the value.
      const head = start + run.token.length - arg.length;
      let value: Span | null = arg === "" ? null : { from: head, to: i };
      if (arg === "") {
        let j = i;
        while (j < n && isInsignificant(text[j]!)) j++;
        if (j < n && !isBoundary(text[j]!)) {
          const tonic = readRun(text, j);
          arg = tonic.token;
          value = { from: j, to: tonic.next };
          i = tonic.next;
        }
      }
      cells.push({
        kind: "key",
        arg,
        directive: { from: start, to: head },
        value,
      });
      continue;
    }

    cells.push({
      kind: "chord",
      item: { token: run.token, span: { from: start, to: i } },
    });
  }

  return cells;
}

/** Expand cells into timed chord events, one bar per top-level cell. */
function expand(
  cells: Cell[],
  marks: Marks,
): { events: ChordEvent[]; keys: KeyChange[]; bars: number } {
  const events: ChordEvent[] = [];
  const keys: KeyChange[] = [];
  let beat = 0;
  // The event a hold extends — null at the start or after a silent slot.
  let lastEvent: ChordEvent | null = null;
  // The key Roman numerals resolve against; a `key:` directive moves it.
  let key = DEFAULT_KEY;

  // Strike a chord token over `[start, start+len)`, recording typos as skipped.
  // A token is a letter-name chord (`Am7`) or a Roman numeral (`vi7`) — tried in
  // that order, since no numeral begins with a note letter, so a chord symbol
  // can never be shadowed by a degree. Returns the new event (or null) so the
  // caller updates `lastEvent` in the linear flow — assigning it only inside
  // this closure would defeat narrowing.
  const strike = (
    { token, span }: Item,
    start: number,
    len: number,
  ): ChordEvent | null => {
    const letter = parseChordSymbol(token);
    const data = letter ?? parseRomanNumeral(token, key);
    if (!data) {
      marks.reject(token, span);
      return null;
    }
    marks.mark(span, letter ? "chord" : "degree");
    const ev: ChordEvent = { data, start, end: start + len };
    events.push(ev);
    return ev;
  };

  for (const cell of cells) {
    if (cell.kind === "chord") {
      lastEvent = strike(cell.item, beat, BEATS_PER_BAR);
    } else if (cell.kind === "hold") {
      marks.mark(cell.span, "hold");
      if (lastEvent) lastEvent.end += BEATS_PER_BAR;
    } else if (cell.kind === "key") {
      // Trivia, like a comment: a key directive establishes context, not a bar.
      const parsed = parseKeySignature(cell.arg);
      const spans = cell.value
        ? [cell.directive, cell.value]
        : [cell.directive];
      if (!parsed) {
        marks.reject(`key:${cell.arg}`, ...spans);
        continue;
      }
      marks.mark(cell.directive, "key-directive");
      if (cell.value) marks.mark(cell.value, "key-value");
      key = parsed;
      // Two directives on the same beat: the last one wins, as it does downstream.
      if (keys.at(-1)?.beat === beat) keys[keys.length - 1] = { beat, key };
      else keys.push({ beat, key });
      continue;
    } else {
      // group: split this one bar equally among its items.
      marks.mark(cell.open, "group-open");
      marks.mark(cell.close, "group-close");
      const { items } = cell;
      if (items.length > 0) {
        const sub = BEATS_PER_BAR / items.length;
        let subBeat = beat;
        for (const item of items) {
          if (item.token === HOLD) {
            marks.mark(item.span, "hold");
            if (lastEvent) lastEvent.end += sub;
          } else {
            lastEvent = strike(item, subBeat, sub);
          }
          subBeat += sub;
        }
      }
    }
    beat += BEATS_PER_BAR;
  }

  return { events, keys, bars: beat / BEATS_PER_BAR };
}

/**
 * Parse the grid text into timed chord events plus the key changes its `key:`
 * directives establish; unparseable tokens are skipped. Also returns the
 * classified source spans the editor colours, and the bar count.
 */
export function parseGrid(text: string): ParsedGrid {
  const marks = new Marks();
  const cells = tokenize(blankComments(text, marks), marks);
  const { events, keys, bars } = expand(cells, marks);
  const tokens = marks.tokens.toSorted((a, b) => a.from - b.from);
  return { events, skipped: marks.skipped, keys, tokens, bars };
}
