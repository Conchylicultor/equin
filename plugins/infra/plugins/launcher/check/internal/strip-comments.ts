import { maskSource } from "@plugins/plugin-meta/plugins/parse-utils/core";

// Blank out the comments of a source file, so a scan over what is left sees
// only code: identifiers, string literals and template text survive, prose
// does not. The result has the SAME length and the same newlines as the input,
// so a line number found in it is the line number in the original file.
//
// Four syntaxes, chosen by path, because the launcher checks scan
// TypeScript, the gateway's Go, the desktop shell's Rust and the git hooks.
// Go and Rust look alike but are read separately: each knows only its own
// literals (Go's backtick strings, Rust's raw strings and nesting comments), so
// neither can misread the other's.
// Anything else throws: a file this cannot read correctly must not be scanned
// as if it had no comments.

/** Replace every character in [start, end) with a space, except newlines. */
function blank(out: string[], start: number, end: number): void {
  for (let i = start; i < end; i++) if (out[i] !== "\n") out[i] = " ";
}

/**
 * TypeScript: the repo's shared masker, keeping strings. It blanks comments and
 * regex literals in one pass over character codes, and its regex-vs-division
 * reading is what every text scan in the repo already relies on.
 *
 * A regex literal therefore counts as not-code, like a comment: a pattern that
 * spells a variable name (a check banning `process.env.EQUIN_DIR`) neither
 * reads nor sets it — the same reason lint rules are not scanned.
 *
 * This used to parse each file into a TypeScript syntax tree and visit every
 * node. Over the whole repo that took ~20 s of the check runner's one shared
 * thread against ~0.5 s here, and found the same names outside regex literals.
 */
function stripTypeScript(src: string): string {
  return maskSource(src, { strings: false });
}

// A Go rune or Rust char literal: `'x'`, `'\''`, `'\u{1F600}'`. Anything else
// starting with `'` (a Rust lifetime, `'a`) is left as code.
const CHAR_LITERAL_RE = /^'(?:\\.[^'\n]*?|[^\\'\n])'/;

/** Blank a `//` comment from `i` to the end of its line; returns where it stopped. */
function blankLineComment(src: string, out: string[], i: number): number {
  const end = src.indexOf("\n", i);
  const stop = end === -1 ? src.length : end;
  blank(out, i, stop);
  return stop;
}

/** Skip a char literal (or step over a lone `'`); returns the next position. */
function skipQuote(src: string, i: number): number {
  const literal = CHAR_LITERAL_RE.exec(src.slice(i, i + 16));
  return i + (literal ? literal[0].length : 1);
}

/**
 * Go: `//` to end of line and `/* … *\/` blocks (which do not nest), skipping
 * over interpreted strings (backslash escapes, never across a newline),
 * backtick raw strings and runes, so a `//` inside `"http://…"` stays code.
 */
function stripGo(src: string): string {
  const out = src.split("");
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    const next = src[i + 1];
    if (c === "/" && next === "/") {
      i = blankLineComment(src, out, i);
    } else if (c === "/" && next === "*") {
      const end = src.indexOf("*/", i + 2);
      const stop = end === -1 ? src.length : end + 2;
      blank(out, i, stop);
      i = stop;
    } else if (c === '"') {
      i++;
      while (i < src.length && src[i] !== '"' && src[i] !== "\n") {
        i += src[i] === "\\" ? 2 : 1;
      }
      i++;
    } else if (c === "`") {
      const end = src.indexOf("`", i + 1);
      i = end === -1 ? src.length : end + 1;
    } else if (c === "'") {
      i = skipQuote(src, i);
    } else {
      i++;
    }
  }
  return out.join("");
}

const IDENT_CHAR_RE = /[A-Za-z0-9_]/;

/** True when position `i` starts a token: the character before it is not part of an identifier. */
function atTokenStart(src: string, i: number): boolean {
  return i === 0 || !IDENT_CHAR_RE.test(src[i - 1]!);
}

// The opening of a Rust raw string after its optional `b` / `c` prefix: `r`,
// any number of `#`, then `"`. `r#type` (a raw identifier) does not match.
const RAW_STRING_OPEN_RE = /^r(#*)"/;

/**
 * Where the raw string opening at `i` ends, or -1 when `i` does not open one.
 * A raw string starts at a token boundary: `r"…"`, `r#"…"#`, `br##"…"##`,
 * `cr"…"`. It ends at the first `"` followed by as many `#` as it opened with,
 * and nothing inside it is an escape or a comment.
 */
function rawStringEnd(src: string, i: number): number {
  let start = i;
  if ((src[i] === "b" || src[i] === "c") && src[i + 1] === "r") start = i + 1;
  if (src[start] !== "r" || !atTokenStart(src, i)) return -1;
  const open = RAW_STRING_OPEN_RE.exec(src.slice(start, start + 256));
  if (!open) return -1;
  const close = `"${open[1]!}`;
  const end = src.indexOf(close, start + open[0].length);
  return end === -1 ? src.length : end + close.length;
}

/**
 * Rust: `//` to end of line and `/* … *\/` blocks, which NEST (`/* a /* b *\/
 * still comment *\/`). Skips over strings, which may span lines (`"…"`,
 * `b"…"`, `c"…"`, with backslash escapes), raw strings (`r#"…"#`, whose
 * contents are never escapes or comments), and char literals (`'x'`, `b'"'`),
 * while a lifetime (`'a`) stays code. A backtick is an ordinary character.
 */
function stripRust(src: string): string {
  const out = src.split("");
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    const next = src[i + 1];
    if (c === "/" && next === "/") {
      i = blankLineComment(src, out, i);
    } else if (c === "/" && next === "*") {
      const start = i;
      let depth = 1;
      i += 2;
      while (i < src.length && depth > 0) {
        if (src[i] === "/" && src[i + 1] === "*") {
          depth++;
          i += 2;
        } else if (src[i] === "*" && src[i + 1] === "/") {
          depth--;
          i += 2;
        } else {
          i++;
        }
      }
      blank(out, start, i);
    } else if (c === '"') {
      i++;
      while (i < src.length && src[i] !== '"') i += src[i] === "\\" ? 2 : 1;
      i++;
    } else if (c === "'") {
      i = skipQuote(src, i);
    } else {
      const raw = rawStringEnd(src, i);
      i = raw === -1 ? i + 1 : raw;
    }
  }
  return out.join("");
}

/**
 * Shell: `#` starts a comment only at the start of a word (line start or after
 * whitespace), so `$#` and `${#var}` stay code, and never inside single or
 * double quotes.
 */
function stripShell(src: string): string {
  const out = src.split("");
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (c === "#" && (i === 0 || /\s/.test(src[i - 1]!))) {
      const end = src.indexOf("\n", i);
      const stop = end === -1 ? src.length : end;
      blank(out, i, stop);
      i = stop;
    } else if (c === "'") {
      const end = src.indexOf("'", i + 1);
      i = end === -1 ? src.length : end + 1;
    } else if (c === '"') {
      i++;
      while (i < src.length && src[i] !== '"') i += src[i] === "\\" ? 2 : 1;
      i++;
    } else if (c === "\\") {
      i += 2;
    } else {
      i++;
    }
  }
  return out.join("");
}

/**
 * `src` with its comments blanked, read with the syntax `path` implies.
 * Throws for a path whose comment syntax this does not know.
 */
export function stripComments(path: string, src: string): string {
  if (path.endsWith(".ts") || path.endsWith(".tsx")) {
    return stripTypeScript(src);
  }
  if (path.endsWith(".go")) return stripGo(src);
  if (path.endsWith(".rs")) return stripRust(src);
  if (path.startsWith(".githooks/")) return stripShell(src);
  throw new Error(
    `stripComments: no comment syntax known for ${path} — add one before scanning this kind of file`,
  );
}
