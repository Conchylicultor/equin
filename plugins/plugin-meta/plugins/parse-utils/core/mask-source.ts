/**
 * Source masking for build-time scanners.
 *
 * `maskSource` returns a copy of `src` of IDENTICAL length where characters that
 * live inside comments, regex literals and (optionally) string interiors are
 * replaced by spaces. Because every offset and newline is preserved 1:1, a regex
 * match index in the masked text maps back to the original — callers read real
 * string values from the original at the matched offset.
 *
 * This generalizes the inline skip-loop in `matchBracket` and the private
 * `stripComments` in the boundaries checker: every raw-text scanner in the repo
 * should route through this primitive so a marker in a comment/string/regex can
 * never be mistaken for code.
 *
 * It runs on every candidate file of every text-scanning check, on the check
 * runner's one shared thread, so it is written for speed: one `charCodeAt` pass
 * over UTF-16 code units, char classes from a lookup table, and the output built
 * from whole untouched slices plus runs of spaces rather than per character.
 */

import { memoInSnapshot } from "./snapshot-scope";

/**
 * Keywords that may be immediately followed by a regex literal even though they
 * end in an identifier char (e.g. `return /x/`, `typeof /x/`). Without this set,
 * the char-level heuristic would mistake the trailing letter for an operand and
 * read the `/` as division.
 */
const REGEX_PRECEDING_KEYWORDS = new Set([
  "return",
  "typeof",
  "instanceof",
  "in",
  "of",
  "new",
  "delete",
  "void",
  "throw",
  "yield",
  "await",
  "case",
  "do",
  "else",
]);

/** Longest entry of {@link REGEX_PRECEDING_KEYWORDS} (`instanceof`). */
const MAX_KEYWORD_LEN = 10;

const NL = 0x0a;
const DQUOTE = 0x22;
const SQUOTE = 0x27;
const RPAREN = 0x29;
const STAR = 0x2a;
const SLASH = 0x2f;
const LBRACKET = 0x5b;
const BACKSLASH = 0x5c;
const RBRACKET = 0x5d;
const BACKTICK = 0x60;
const RBRACE = 0x7d;

/** `prevSig` sentinels: start of input, and "a string/regex literal". */
const SIG_NONE = -1;
const SIG_VALUE = -2;

/** ASCII class bits: `[A-Za-z0-9_$]` and `\s`. */
const IDENT = 1;
const SPACE = 2;

const ASCII_CLASS = buildAsciiClass();

function buildAsciiClass(): Uint8Array {
  const table = new Uint8Array(128);
  for (let c = 0; c < 128; c++) {
    const ch = String.fromCharCode(c);
    if (/[A-Za-z0-9_$]/.test(ch)) table[c] = IDENT;
    else if (/\s/.test(ch)) table[c] = SPACE;
  }
  return table;
}

/** `/\s/` for a code unit ≥ 128: the Unicode spaces JS treats as whitespace. */
function isNonAsciiSpace(c: number): boolean {
  return (
    c === 0xa0 ||
    c === 0x1680 ||
    (c >= 0x2000 && c <= 0x200a) ||
    c === 0x2028 ||
    c === 0x2029 ||
    c === 0x202f ||
    c === 0x205f ||
    c === 0x3000 ||
    c === 0xfeff
  );
}

let spaceRun = " ".repeat(256);

/** A string of `k` spaces. */
function spaces(k: number): string {
  if (k > spaceRun.length)
    spaceRun = " ".repeat(Math.max(k, spaceRun.length * 2));
  return spaceRun.slice(0, k);
}

export function maskSource(src: string, opts?: { strings?: boolean }): string {
  const maskStrings = opts?.strings ?? true;
  // A pure function of (src, strings): memoized for the ambient snapshot's
  // build, where every facet masks the same files again.
  return memoInSnapshot(
    maskStrings ? "maskSource:strings" : "maskSource:code",
    src,
    (text) => maskUncached(text, maskStrings),
  );
}

function maskUncached(src: string, maskStrings: boolean): string {
  const n = src.length;

  // The output is src[0, copied) verbatim, then each masked span as spaces with
  // its newlines kept, then the rest verbatim. `nextNl` is a cursor on the next
  // newline at or after the last span, so finding newlines is one pass overall.
  let out = "";
  let copied = 0;
  let nextNl = src.indexOf("\n");

  // Blank [from, to). `to` may be n + 1: a regex escape on the very last char
  // blanks one position past the end, which appends a space (kept for parity
  // with the original per-character implementation).
  const blank = (from: number, to: number) => {
    if (to <= from) return;
    out += src.slice(copied, from);
    if (nextNl >= 0 && nextNl < from) nextNl = src.indexOf("\n", from);
    let p = from;
    while (nextNl >= 0 && nextNl < to) {
      out += spaces(nextNl - p) + "\n";
      p = nextNl + 1;
      nextNl = src.indexOf("\n", p);
    }
    out += spaces(to - p);
    copied = to;
  };

  let i = 0;
  // Last significant (non-whitespace, non-comment) char code seen, or a SIG_*
  // sentinel — for regex vs division.
  let prevSig = SIG_NONE;
  // The identifier word that ended at `prevSig`, for keyword detection: its
  // total length, and its first MAX_KEYWORD_LEN code units (a longer word can
  // never be a keyword). Whitespace and comments do not end a word.
  let wordLen = 0;
  const word = new Uint16Array(MAX_KEYWORD_LEN);

  /**
   * Whether a `/` here begins a regex literal (vs division). Standard heuristic:
   * a regex unless the previous significant token produced a value — an
   * identifier/number, `)`, `]`, `}`, or a string/regex literal — except after a
   * keyword that takes an expression on its right (`return`, `typeof`, …).
   */
  const regexCanStart = (): boolean => {
    if (prevSig === SIG_NONE) return true;
    if (prevSig === SIG_VALUE) return false;
    if (prevSig === RPAREN || prevSig === RBRACKET || prevSig === RBRACE)
      return false;
    if (prevSig < 128 && ASCII_CLASS[prevSig] === IDENT) {
      return (
        wordLen <= MAX_KEYWORD_LEN &&
        REGEX_PRECEDING_KEYWORDS.has(
          String.fromCharCode(...word.subarray(0, wordLen)),
        )
      );
    }
    return true;
  };

  while (i < n) {
    const c = src.charCodeAt(i);

    if (c === SLASH) {
      const next = src.charCodeAt(i + 1);

      // Line comment: blank `//` and everything up to (not including) the newline.
      if (next === SLASH) {
        let end = src.indexOf("\n", i + 2);
        if (end < 0) end = n;
        blank(i, end);
        i = end;
        continue;
      }

      // Block comment: blank `/* … */` including delimiters; keep interior newlines.
      if (next === STAR) {
        const close = src.indexOf("*/", i + 2);
        const end = close < 0 ? n : close + 2;
        blank(i, end);
        i = end;
        continue;
      }

      // Regex literal: opaque, blank interior + delimiters. Honors escapes and
      // character classes (a `/` inside `[ … ]` does not end the regex).
      if (regexCanStart()) {
        const start = i;
        i++;
        let inClass = false;
        while (i < n) {
          const r = src.charCodeAt(i);
          // Unterminated regex (shouldn't happen in valid source) — stop here.
          if (r === NL) break;
          if (r === BACKSLASH) {
            i += 2;
            continue;
          }
          if (r === LBRACKET) inClass = true;
          else if (r === RBRACKET) inClass = false;
          else if (r === SLASH && !inClass) {
            i++; // closing '/'
            break;
          }
          i++;
        }
        // Flag characters (a-z) following the closing delimiter.
        while (i < n) {
          const f = src.charCodeAt(i);
          if (f < 0x61 || f > 0x7a) break;
          i++;
        }
        blank(start, i);
        prevSig = SIG_VALUE; // a regex literal as a whole is a value
        wordLen = 0;
        continue;
      }

      // Division: an ordinary significant char.
      prevSig = SLASH;
      wordLen = 0;
      i++;
      continue;
    }

    // String / template literal: delimiters kept verbatim, interior optionally blanked.
    if (c === DQUOTE || c === SQUOTE || c === BACKTICK) {
      i++;
      const start = i;
      while (i < n) {
        const s = src.charCodeAt(i);
        if (s === c) break;
        i += s === BACKSLASH && i + 1 < n ? 2 : 1;
      }
      if (maskStrings) blank(start, i);
      if (i < n) i++; // closing delimiter (if present)
      prevSig = SIG_VALUE; // a string literal as a whole is a value
      wordLen = 0;
      continue;
    }

    // Ordinary character.
    if (c < 128) {
      const cls = ASCII_CLASS[c]!;
      if (cls !== SPACE) {
        prevSig = c;
        if (cls === IDENT) {
          if (wordLen < MAX_KEYWORD_LEN) word[wordLen] = c;
          wordLen++;
        } else {
          wordLen = 0;
        }
      }
    } else if (!isNonAsciiSpace(c)) {
      prevSig = c;
      wordLen = 0;
    }
    i++;
  }

  if (copied === 0) return src;
  return copied < n ? out + src.slice(copied) : out;
}
