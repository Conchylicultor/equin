import { test, expect } from "bun:test";
import {
  readStringLiteral,
  parseStringField,
  parseBoolField,
  defaultExportObjectBody,
  hasField,
  parseStaticCallId,
  readStaticCallId,
  unresolvableCallIdMessage,
} from "./helpers";
import { markerCallSpans } from "./find-marker-calls";
import { maskSource } from "./mask-source";

// ── readStringLiteral: quote forms + round-trip ────────────────────

test("reads all three quote forms", () => {
  expect(readStringLiteral(`"hello"`, 0)).toEqual({
    kind: "value",
    value: "hello",
    end: 7,
  });
  expect(readStringLiteral(`'hello'`, 0)).toEqual({
    kind: "value",
    value: "hello",
    end: 7,
  });
  expect(readStringLiteral("`hello`", 0)).toEqual({
    kind: "value",
    value: "hello",
    end: 7,
  });
});

test("non-quote start → none", () => {
  expect(readStringLiteral("hello", 0)).toEqual({ kind: "none" });
  expect(readStringLiteral("  x", 0)).toEqual({ kind: "none" });
});

test("`end` points just past the closing quote", () => {
  const src = `xx "ab" yy`;
  const r = readStringLiteral(src, 3);
  expect(r).toEqual({ kind: "value", value: "ab", end: 7 });
  expect(src[r.kind === "value" ? r.end : -1]).toBe(" ");
});

// ── the reported bug: embedded escaped quotes ──────────────────────

test("double-quoted value with escaped quotes round-trips WITH the quotes", () => {
  // `"a onDelete:\"cascade\" bound"` — the exact reported bug.
  const src = '"a onDelete:\\"cascade\\" bound"';
  expect(readStringLiteral(src, 0)).toEqual({
    kind: "value",
    value: 'a onDelete:"cascade" bound',
    end: src.length,
  });
});

test("apostrophes across quote forms", () => {
  expect(readStringLiteral("'it\\'s'", 0)).toEqual({
    kind: "value",
    value: "it's",
    end: 7,
  });
  expect(readStringLiteral(`"it's"`, 0)).toEqual({
    kind: "value",
    value: "it's",
    end: 6,
  });
});

// ── escape cooking ─────────────────────────────────────────────────

test("cooks standard escapes", () => {
  expect(readStringLiteral('"a\\nb"', 0)).toMatchObject({ value: "a\nb" });
  expect(readStringLiteral('"a\\\\b"', 0)).toMatchObject({ value: "a\\b" });
  expect(readStringLiteral('"a\\tb"', 0)).toMatchObject({ value: "a\tb" });
});

test("cooks \\xHH, \\uHHHH, \\u{...}", () => {
  expect(readStringLiteral('"\\x41"', 0)).toMatchObject({ value: "A" });
  expect(readStringLiteral('"\\u0041"', 0)).toMatchObject({ value: "A" });
  expect(readStringLiteral('"\\u{1F600}"', 0)).toMatchObject({
    value: "\u{1F600}",
  });
});

test("unknown escape yields the char itself", () => {
  expect(readStringLiteral('"\\q"', 0)).toMatchObject({ value: "q" });
});

test("line continuation decodes to nothing", () => {
  expect(readStringLiteral('"a\\\nb"', 0)).toMatchObject({ value: "ab" });
});

// ── backtick specifics ─────────────────────────────────────────────

// Built by concatenation rather than written inline: a literal `${` inside a
// plain string trips the `no-template-curly-in-string` lint rule, which cannot
// tell a fixture apart from a template literal someone quoted by mistake.
const OPEN_INTERP = "$" + "{";

test("backtick with unescaped interpolation → dynamic", () => {
  const r = readStringLiteral("`hi " + OPEN_INTERP + "x} there`", 0);
  expect(r.kind).toBe("dynamic");
});

test("backtick with escaped interpolation → value", () => {
  const r = readStringLiteral("`hi \\" + OPEN_INTERP + "x}`", 0);
  expect(r).toMatchObject({ kind: "value", value: "hi " + OPEN_INTERP + "x}" });
});

test("backtick multi-line → whitespace collapsed", () => {
  const r = readStringLiteral("`line one\n  line two`", 0);
  expect(r).toMatchObject({ kind: "value", value: "line one line two" });
});

test("double-quoted \\n is NOT collapsed (stays a real newline)", () => {
  const r = readStringLiteral('"line one\\n  line two"', 0);
  expect(r).toMatchObject({ kind: "value", value: "line one\n  line two" });
});

test("unterminated literal → dynamic, no hang/throw", () => {
  const r = readStringLiteral('"never closed', 0);
  expect(r.kind).toBe("dynamic");
});

// ── parseStringField ───────────────────────────────────────────────

test("reads a plain string field", () => {
  expect(parseStringField(`{ description: "hi" }`, "description")).toEqual({
    kind: "value",
    value: "hi",
  });
});

test("field value with embedded escaped quotes (the docs bug)", () => {
  const src = 'x = { description: "a onDelete:\\"cascade\\" bound" }';
  expect(parseStringField(src, "description")).toEqual({
    kind: "value",
    value: 'a onDelete:"cascade" bound',
  });
});

test("identifier value → dynamic with expr", () => {
  expect(parseStringField(`{ description: MY_CONST }`, "description")).toEqual({
    kind: "dynamic",
    expr: "MY_CONST",
  });
});

test("call value → dynamic", () => {
  expect(
    parseStringField(`{ description: makeIt("x") }`, "description"),
  ).toMatchObject({
    kind: "dynamic",
  });
});

test("absent key → absent", () => {
  expect(parseStringField(`{ name: "x" }`, "description")).toEqual({
    kind: "absent",
  });
});

test("description: inside a // comment → absent", () => {
  expect(
    parseStringField(
      `// description: "commented"\n{ name: "x" }`,
      "description",
    ),
  ).toEqual({
    kind: "absent",
  });
});

test("description: inside a /* */ comment → absent", () => {
  expect(
    parseStringField(
      `/* description: "commented" */\n{ name: "x" }`,
      "description",
    ),
  ).toEqual({
    kind: "absent",
  });
});

test("description: inside a string literal → absent", () => {
  expect(
    parseStringField(`{ note: "description: not real" }`, "description"),
  ).toEqual({
    kind: "absent",
  });
});

// ── depth0 scoping ─────────────────────────────────────────────────

test("depth0: nested description does not shadow a later top-level one", () => {
  const body = `contribs: [{ description: "inner" }], description: "outer"`;
  expect(parseStringField(body, "description", { depth0: true })).toEqual({
    kind: "value",
    value: "outer",
  });
});

test("depth0: only a nested key present → absent", () => {
  const body = `contribs: [{ description: "inner" }], name: "top"`;
  expect(parseStringField(body, "description", { depth0: true })).toEqual({
    kind: "absent",
  });
});

test("without depth0: first match anywhere wins (nested included)", () => {
  const body = `contribs: [{ description: "inner" }], description: "outer"`;
  expect(parseStringField(body, "description")).toEqual({
    kind: "value",
    value: "inner",
  });
});

// ── parseBoolField ─────────────────────────────────────────────────

test("parseBoolField reads true/false and defaults false when absent", () => {
  expect(parseBoolField(`{ loadBearing: true }`, "loadBearing")).toBe(true);
  expect(parseBoolField(`{ loadBearing: false }`, "loadBearing")).toBe(false);
  expect(parseBoolField(`{ name: "x" }`, "loadBearing")).toBe(false);
});

test("parseBoolField depth0: nested flag does not leak", () => {
  const body = `contribs: [{ loadBearing: true }], name: "x"`;
  expect(parseBoolField(body, "loadBearing", { depth0: true })).toBe(false);
});

test("parseBoolField ignores a flag inside a comment", () => {
  expect(
    parseBoolField(`// loadBearing: true\n{ name: "x" }`, "loadBearing"),
  ).toBe(false);
});

// ── defaultExportObjectBody ────────────────────────────────────────

test("isolates a normal barrel's default-export object body", () => {
  const src = `import x from "y";\nexport default { name: "foo", loadBearing: true };`;
  const r = defaultExportObjectBody(src);
  expect(r.kind).toBe("object");
  expect(r.kind === "object" && r.body).toContain(`name: "foo"`);
});

test("export default {} → object with EMPTY body (not absent)", () => {
  expect(defaultExportObjectBody(`export default {}`)).toEqual({
    kind: "object",
    body: "",
  });
});

test("no default export → absent", () => {
  expect(defaultExportObjectBody(`export const x = 1;`)).toEqual({
    kind: "absent",
  });
});

test("export default that is not an object → absent", () => {
  expect(defaultExportObjectBody(`export default makePlugin();`)).toEqual({
    kind: "absent",
  });
});

test("export default inside a comment → absent", () => {
  expect(
    defaultExportObjectBody(`// export default { x: 1 }\nexport const y = 2;`),
  ).toEqual({
    kind: "absent",
  });
});

// ── parseStaticCallId: the discriminated sibling of readStaticCallId ─

function span(src: string, marker: string) {
  const s = markerCallSpans(maskSource(src), marker)[0];
  if (!s) throw new Error(`no ${marker} call in fixture`);
  return s;
}

test("static literal first argument → value (all three quote forms)", () => {
  for (const q of [`"a.b"`, `'a.b'`, "`a.b`"]) {
    const src = `defineX(${q}, cfg);`;
    expect(parseStaticCallId(src, span(src, "defineX"))).toEqual({
      kind: "value",
      value: "a.b",
    });
  }
});

test("an EMPTY literal is a value, not a miss", () => {
  const src = `defineX("", cfg);`;
  expect(parseStaticCallId(src, span(src, "defineX"))).toEqual({
    kind: "value",
    value: "",
  });
});

test("no arguments at all → absent", () => {
  const src = `defineX();`;
  expect(parseStaticCallId(src, span(src, "defineX"))).toEqual({
    kind: "absent",
  });
});

test("hoisted identifier id → dynamic, naming the expression", () => {
  const src = `const ID = "x";\ndefineX(ID, cfg);`;
  const r = parseStaticCallId(src, span(src, "defineX"));
  expect(r).toEqual({ kind: "dynamic", expr: "ID, cfg" });
});

test("interpolated template id → dynamic, never the template's interior", () => {
  // Written as an escaped template so the fixture holds the literal characters
  // `${id}` without this file itself interpolating (or tripping
  // no-template-curly-in-string, which a plain "…${id}…" would).
  const src = `defineX(\`\${id}.section\`, cfg);`;
  const r = parseStaticCallId(src, span(src, "defineX"));
  expect(r).toEqual({ kind: "dynamic", expr: `\`\${id}.section\`, cfg` });
});

test("the dynamic snippet stops at the call's own closing paren", () => {
  // The snippet is capped at ~60 chars, so a SHORT unresolvable call used to
  // drag the next statement into the reported expression.
  const src = `defineX(\`\${a}.b\`, c);\nconst SOMETHING_ELSE = 1;`;
  const r = parseStaticCallId(src, span(src, "defineX"));
  expect(r).toEqual({ kind: "dynamic", expr: `\`\${a}.b\`, c` });
});

test("readStaticCallId is parseStaticCallId flattened to string | null", () => {
  const ok = `defineX("a.b");`;
  expect(readStaticCallId(ok, span(ok, "defineX"))).toBe("a.b");
  const dyn = `defineX(ID);`;
  expect(readStaticCallId(dyn, span(dyn, "defineX"))).toBeNull();
  const none = `defineX();`;
  expect(readStaticCallId(none, span(none, "defineX"))).toBeNull();
});

test("unresolvableCallIdMessage names file, line, marker and expression", () => {
  const msg = unresolvableCallIdMessage({
    marker: "defineRenderSlot",
    file: "plugins/apps/plugins/pages/plugins/page-tree/web/slots.ts",
    line: 42,
    expr: "ID",
    hint: "Inline the literal.",
  });
  expect(msg).toContain(
    "plugins/apps/plugins/pages/plugins/page-tree/web/slots.ts:42",
  );
  expect(msg).toContain("defineRenderSlot");
  expect(msg).toContain("`ID`");
  expect(msg).toContain("Inline the literal.");
});

test("unresolvableCallIdMessage says so when there are no arguments", () => {
  const msg = unresolvableCallIdMessage({
    marker: "defineDataView",
    file: "f.ts",
    line: 1,
    expr: "",
    hint: "h",
  });
  expect(msg).toContain("the call has no arguments");
});

// ── hasField: presence as a key or a shorthand member ──────────────

test("hasField sees a key with any value, and a shorthand member", () => {
  const o = { depth0: true };
  expect(
    hasField(` route: "x", needsMachine: FEATURE `, "needsMachine", o),
  ).toBe(true);
  expect(hasField(` needsMachine, route: "x" `, "needsMachine", o)).toBe(true);
  expect(hasField(` route: "x", needsMachine `, "needsMachine", o)).toBe(true);
  expect(hasField(`{ route: "x", needsMachine }`, "needsMachine")).toBe(true);
});

test("hasField ignores a nested member at depth 0, a comment, a string and a longer name", () => {
  const o = { depth0: true };
  expect(
    hasField(` spec: { needsMachine }, route: "x" `, "needsMachine", o),
  ).toBe(false);
  expect(
    hasField(` route: "needsMachine, " // needsMachine,\n`, "needsMachine", o),
  ).toBe(false);
  expect(hasField(` needsMachineToo, route: "x" `, "needsMachine", o)).toBe(
    false,
  );
});
