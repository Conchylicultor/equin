/**
 * Tests for the source-masking primitive. Run with `bun test` from the repo root.
 *
 * The hard invariant under test: `maskSource` preserves length and newline
 * positions exactly, while blanking comments, regex literals and (optionally)
 * string interiors to spaces. Callers rely on offsets mapping 1:1 back to the
 * original source.
 */

import { test, expect } from "bun:test";
import { maskSource, findMarkerCalls } from "./index";

// --- helpers ---------------------------------------------------------------

/** Assert the length/newline invariant holds between input and output. */
function expectShapePreserved(input: string, output: string) {
  expect(output.length).toBe(input.length);
  for (let i = 0; i < input.length; i++) {
    if (input[i] === "\n") expect(output[i]).toBe("\n");
    else expect(output[i]).not.toBe("\n");
  }
}

/** Mask and assert the shape invariant, returning the masked output. */
function mask(src: string, opts?: { strings?: boolean }): string {
  const out = maskSource(src, opts);
  expectShapePreserved(src, out);
  return out;
}

// --- comments --------------------------------------------------------------

test("line comment is blanked, newline preserved", () => {
  const src = "const a = 1; // hello world\nconst b = 2;";
  const out = mask(src);
  expect(out).toBe("const a = 1;               \nconst b = 2;");
});

test("block comment is blanked including delimiters", () => {
  const src = "a/* comment */b";
  const out = mask(src);
  expect(out).toBe("a             b");
});

test("multi-line block comment preserves interior newlines", () => {
  const src = "a/* line1\nline2 */b";
  const out = mask(src);
  expect(out).toBe("a        \n        b");
  expect(out.split("\n").length).toBe(2);
});

// --- strings ---------------------------------------------------------------

test("string interior blanked, delimiters kept (default strings:true)", () => {
  const src = 'const s = "hello";';
  const out = mask(src);
  expect(out).toBe('const s = "     ";');
});

test("escaped quotes inside strings are handled", () => {
  const src = 'const s = "a\\"b";';
  const out = mask(src);
  // delimiters kept; interior (incl. escape) blanked
  expect(out).toBe('const s = "    ";');
});

test("backslash-backslash escape inside string", () => {
  const src = 'const s = "a\\\\b";';
  const out = mask(src);
  expect(out).toBe('const s = "    ";');
});

test("single-quoted string interior blanked", () => {
  const src = "const s = 'xy';";
  const out = mask(src);
  expect(out).toBe("const s = '  ';");
});

test("template literal interior blanked", () => {
  // Build the `${b}` token via concatenation so this plain string isn't itself
  // flagged by no-template-curly-in-string; the value is `const s = ` + "`a${b}c`;".
  const src = "const s = `a$" + "{b}c`;";
  const out = mask(src);
  expect(out).toBe("const s = `      `;");
});

test("strings:false keeps string interiors verbatim", () => {
  const src = 'const s = "keep me"; // drop me';
  const out = mask(src, { strings: false });
  expect(out).toBe('const s = "keep me";           ');
});

test("strings:false still blanks comments and regex", () => {
  const src = 'const r = /abc/; const s = "kept"; /* c */';
  const out = mask(src, { strings: false });
  expect(out).toBe('const r =      ; const s = "kept";        ');
});

// --- regex literals --------------------------------------------------------

test("regex literal containing quotes and slashes is opaque", () => {
  const src = 'const r = /a"b\\/\\/c/g;';
  const out = mask(src);
  // entire literal incl. delimiters and flags blanked; surrounding kept
  expect(out).toBe("const r =            ;");
});

test("regex literal with double-slash inside is not a comment", () => {
  const src = "const r = /a\\/\\/b/; const x = 1;";
  const out = mask(src);
  // /a\/\/b/ is 8 chars; preceded by the existing space after '='.
  expect(out).toBe("const r =         ; const x = 1;");
});

test("regex with character class containing slash", () => {
  const src = "const r = /[/]/;";
  const out = mask(src);
  expect(out).toBe("const r =      ;");
});

test("regex flags are blanked", () => {
  const src = "const r = /x/gim;";
  const out = mask(src);
  // /x/gim is 6 chars; preceded by the existing space after '='.
  expect(out).toBe("const r =       ;");
});

// --- divide vs regex disambiguation ----------------------------------------

test("division after identifier is not a regex", () => {
  const src = "const x = a / b / c;";
  const out = mask(src);
  // no masking — all division
  expect(out).toBe(src);
});

test("a JSX closing tag is not a regex", () => {
  const src = `<p><b className="x">a</b> b <i className="y">c</i><>d</></p>;`;
  expect(maskSource(src, { strings: false })).toBe(src);
});

test("division after number is not a regex", () => {
  const src = "const x = 10 / 2;";
  const out = mask(src);
  expect(out).toBe(src);
});

test("division after closing paren is not a regex", () => {
  const src = "const x = (a) / b;";
  const out = mask(src);
  expect(out).toBe(src);
});

test("division after closing bracket is not a regex", () => {
  const src = "const x = arr[0] / 2;";
  const out = mask(src);
  expect(out).toBe(src);
});

test("regex after = (not a value) is masked", () => {
  const src = "const r = /abc/;";
  const out = mask(src);
  expect(out).toBe("const r =      ;");
});

test("regex after return keyword is masked", () => {
  const src = "return /abc/.test(x);";
  const out = mask(src);
  expect(out).toBe("return      .test(x);");
});

test("division after string is not a regex", () => {
  // "ab".length / 2 — the `/` follows `length` (identifier), division.
  const src = 'const x = "ab".length / 2;';
  const out = mask(src);
  expect(out).toBe('const x = "  ".length / 2;');
});

test("division after closing brace is not a regex", () => {
  const src = "x = {} / 2 / 3;";
  expect(mask(src)).toBe(src);
});

test("regex after an open paren or comma is masked", () => {
  expect(mask("f(/a/, /b/)")).toBe("f(   ,    )");
});

test("regex after each expression-leading keyword is masked", () => {
  expect(mask("typeof /a/")).toBe("typeof    ");
  expect(mask("case /a/:")).toBe("case    :");
  expect(mask("yield /a/i")).toBe("yield     ");
  expect(mask("f(x) instanceof /a/")).toBe("f(x) instanceof    ");
});

test("keyword detection spans whitespace and comments, not longer words", () => {
  // `return` ended at `n`; the comment and newline do not end the word.
  expect(mask("return /* c */\n/a/")).toBe("return        \n   ");
  // `returned` / `xreturn` are operands, so the `/` is division.
  expect(mask("returned / 2 / 3")).toBe("returned / 2 / 3");
  expect(mask("xreturn / 2 / 3")).toBe("xreturn / 2 / 3");
});

test("regex flags stop at the first non-lowercase char", () => {
  expect(mask("x = /a/gU;")).toBe("x =     U;");
});

// --- escapes, unterminated input, unicode ----------------------------------

test("template literal with escaped backtick and interpolation", () => {
  // `$` + `{c}` concatenated for no-template-curly-in-string, as above.
  const src = "t = `a\\`b$" + "{c}`; d";
  expect(mask(src)).toBe("t = `        `; d");
  expect(mask(src, { strings: false })).toBe(src);
});

// A substitution is code up to its matching `}`: a template nested in it does
// not end the outer one. Read as flat text, the outer template ended at the
// first nested backtick and the masker was out of sync for the rest of the file
// — server-core's `export default` was blanked, and its check never registered.
// `$` + `{` concatenated for no-template-curly-in-string, as above.
const S = "$" + "{";

test("template nested in a substitution stays inside its template", () => {
  const src =
    "t = `a " + S + "xs.map((x) => `" + S + "x}`)} b`;\nexport default c;";
  const out = mask(src);
  expect(out.split("\n")[1]).toBe("export default c;");
  expect(out.startsWith("t = `")).toBe(true);
  expect(out.split("\n")[0]!.endsWith("`;")).toBe(true);
  expect(out).not.toContain("map");
});

test("a substitution's braces, strings and comments do not end it", () => {
  const src =
    "t = `" + S + "f({ a: '}', b: \"`\" })/* } */} x`; export default 1;";
  expect(mask(src)).toMatch(/`; export default 1;$/);
});

test("a regex in a substitution may hold a backtick", () => {
  const src = "t = `" + S + "s.replace(/`/g, '')}`; export default 1;";
  expect(mask(src)).toMatch(/`; export default 1;$/);
});

test("a division after a postfix increment in a substitution is no regex", () => {
  const src = "a = `" + S + "i++ / 2}`;\nexport default 1;";
  expect(mask(src).split("\n")[1]).toBe("export default 1;");
});

test("escaped newline inside a string keeps the newline", () => {
  expect(mask('s = "a\\\nb";')).toBe('s = "  \n ";');
});

test("unterminated string blanks to end of input", () => {
  expect(mask('s = "abc')).toBe('s = "   ');
});

test("unterminated block comment blanks to end of input", () => {
  expect(mask("a /* x\ny")).toBe("a     \n ");
});

test("unterminated regex stops at the newline", () => {
  expect(mask("x = /ab\ny / 2")).toBe("x =    \ny / 2");
});

test("unicode whitespace does not end a keyword", () => {
  expect(mask("return /a/")).toBe("return    ");
  expect(mask("return　/a/")).toBe("return　   ");
  expect(mask("return﻿/a/")).toBe("return﻿   ");
});

test("a non-ASCII operand char lets a regex start", () => {
  // `é` is neither whitespace nor an ASCII identifier char.
  expect(mask("é / 2 /")).toBe("é      ");
});

test("CR is blanked inside a line comment; only LF is kept", () => {
  expect(mask("a // c\r\nb")).toBe("a      \nb");
});

test("source with nothing to mask comes back unchanged", () => {
  const src = "const x = a / b;\nexport { x };\n";
  expect(maskSource(src)).toBe(src);
  expect(maskSource(src, { strings: false })).toBe(src);
  expect(maskSource("")).toBe("");
});

// --- the trigger: marker in comment/string/regex ---------------------------

test("marker-shaped regex literal does not leak its name", () => {
  const src = "const DEFINE_RE = /defineCollectedDir\\(/;";
  const out = mask(src);
  expect(out).not.toContain("defineCollectedDir");
});

// === findMarkerCalls =======================================================

test("findMarkerCalls finds a real call and reads original arg text", () => {
  const src = 'foo(); defineX("a"); bar();';
  const calls = findMarkerCalls(src, "defineX");
  expect(calls.length).toBe(1);
  expect(calls[0]!.argsText).toBe('"a"');
  expect(src.slice(calls[0]!.index, calls[0]!.index + "defineX".length)).toBe(
    "defineX",
  );
});

test("findMarkerCalls skips occurrences in comments and strings", () => {
  const src = [
    '// defineX("commented")',
    "const s = \"defineX('stringed')\";",
    'defineX("real");',
  ].join("\n");
  const calls = findMarkerCalls(src, "defineX");
  expect(calls.length).toBe(1);
  expect(calls[0]!.argsText).toBe('"real"');
});

test("findMarkerCalls captures balanced args with nested parens", () => {
  const src = "defineX({ fn: () => bar(1) });";
  const calls = findMarkerCalls(src, "defineX");
  expect(calls.length).toBe(1);
  expect(calls[0]!.argsText).toBe("{ fn: () => bar(1) }");
});

test("findMarkerCalls escapes regex metachars in marker name", () => {
  const src = "a.b(1);";
  // marker "a.b" must match literally, not as a regex
  const calls = findMarkerCalls(src, "a.b");
  expect(calls.length).toBe(1);
  expect(calls[0]!.argsText).toBe("1");
});
