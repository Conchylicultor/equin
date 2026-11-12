import { describe, expect, test } from "bun:test";
import { declarations, stylesheetReads } from "./scan";

const A = "data-input-modality";
const css = (src: string) =>
  stylesheetReads(src, A, { css: true }).map((h) => h.text);
const script = (src: string) =>
  stylesheetReads(src, A, { css: false }).map((h) => h.text);

describe("declarations", () => {
  test("reads a literal attribute", () => {
    expect(
      declarations(
        `const S = defineScriptState("${A}");\nconst T = defineScriptState('data-b');`,
      ),
    ).toEqual([
      { ok: true, index: 10, attribute: A },
      { ok: true, index: 62, attribute: "data-b" },
    ]);
  });
  test("a non-literal attribute is unreadable", () => {
    const [d] = declarations("const S = defineScriptState(ATTR);");
    expect(d?.ok).toBe(false);
  });
  test("skips the definition and comment lines", () => {
    expect(
      declarations(
        "export function defineScriptState(attribute) {}\n * `defineScriptState(x)` …\n// defineScriptState(y)",
      ),
    ).toEqual([]);
  });
});

describe("stylesheetReads: CSS", () => {
  test("any attribute selector naming it", () => {
    expect(css(`[${A}="pointer"] .focus-ring { outline: none }`)).toEqual([
      `[${A}`,
    ]);
    expect(css(`.r:focus-visible:not(:where([${A}="pointer"] *)) {}`)).toEqual([
      `[${A}`,
    ]);
    expect(css(`:root:not([ ${A}]) .x {}`)).toEqual([`[ ${A}`]);
  });
  test("not a longer attribute sharing the prefix", () => {
    expect(css(`[${A}-x] .y {}`)).toEqual([]);
    expect(css(`[data-pointer-focus] {}`)).toEqual([]);
  });
  test("@apply variants", () => {
    expect(
      css(`.x { @apply in-data-[input-modality=pointer]:hidden; }`),
    ).toEqual(["data-[input-modality=pointer]:"]);
  });
});

describe("stylesheetReads: Tailwind variants in script", () => {
  test("arbitrary variants", () => {
    expect(script(`cn("[[${A}=pointer]_&]:ring-0")`)).toEqual([
      `[[${A}=pointer]_&]:`,
    ]);
    expect(script(`"p-2 [&:not([${A}=pointer]_*)]:ring-2"`)).toEqual([
      `[&:not([${A}=pointer]_*)]:`,
    ]);
    expect(script(`"in-[[${A}]]:hidden"`)).toEqual([`in-[[${A}]]:`]);
  });
  test("data variants, any prefix, and the shorthand", () => {
    expect(script(`"in-data-[input-modality=pointer]:hidden"`)).toEqual([
      "data-[input-modality=pointer]:",
    ]);
    expect(script(`"group-data-[input-modality]:p-2"`)).toEqual([
      "data-[input-modality]:",
    ]);
    expect(script(`"in-${A}:hidden"`)).toEqual([`${A}:`]);
  });
  test("script reads and comments are not stylesheet reads", () => {
    expect(script(`doc.querySelector('[${A}="pointer"]')`)).toEqual([]);
    expect(script(`el.closest("[${A}]:focus-within")`)).toEqual([]);
    expect(script(`q('[${A}="pointer"]:not(.x)')`)).toEqual([]);
    expect(script(`root.dataset.inputModality = "pointer";`)).toEqual([]);
    expect(script(`el.setAttribute("${A}", "pointer")`)).toEqual([]);
    expect(script(`<div ${A}="pointer" />`)).toEqual([]);
    expect(script(`// a [[${A}]_&]:p-2 variant`)).toEqual([]);
    expect(
      script(`"data-[input-modality-x]:p-2 data-input-modality-x:p-2"`),
    ).toEqual([]);
  });
});
