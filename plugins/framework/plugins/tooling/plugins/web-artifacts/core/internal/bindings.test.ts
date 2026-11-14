import { describe, expect, test } from "bun:test";
import { parseStatementBindings, renderStatement } from "./bindings";

// The clause is what es-module-lexer's static record spans up to the
// specifier: `code.slice(imp.importStart, imp.start)`, ending at its quote.
describe("parseStatementBindings", () => {
  test("named imports keep both halves of every `a as b`", () => {
    expect(parseStatementBindings(`import{a as s,b}from"`)).toMatchObject({
      reexport: false,
      named: [
        { imported: "a", local: "s" },
        { imported: "b", local: "b" },
      ],
      namespace: null,
      opaque: false,
    });
  });

  test("a default import is the `default` binding", () => {
    expect(parseStatementBindings(`import D,{c}from"`).named).toEqual([
      { imported: "default", local: "D" },
      { imported: "c", local: "c" },
    ]);
  });

  test("re-exports, unminified spacing included", () => {
    expect(parseStatementBindings(`export { t as X, y } from "`)).toMatchObject(
      {
        reexport: true,
        named: [
          { imported: "t", local: "X" },
          { imported: "y", local: "y" },
        ],
      },
    );
  });

  test("namespace, star and side-effect forms are reported, never rewritten", () => {
    expect(parseStatementBindings(`import*as n from"`).namespace).toBe("n");
    expect(parseStatementBindings(`export*from"`).star).toBe(true);
    expect(parseStatementBindings(`import"`).sideEffectOnly).toBe(true);
    expect(parseStatementBindings(`import D,*as n from"`)).toMatchObject({
      namespace: "n",
      named: [{ imported: "default", local: "D" }],
    });
  });

  test("a shape it does not read is opaque", () => {
    expect(parseStatementBindings(`import{a as b as c}from"`).opaque).toBe(
      true,
    );
    expect(parseStatementBindings(`whatever`).opaque).toBe(true);
  });
});

describe("renderStatement", () => {
  test("round-trips through the parser", () => {
    const text = renderStatement({
      reexport: false,
      bindings: [
        { imported: "default", local: "D" },
        { imported: "a", local: "a" },
        { imported: "b", local: "c" },
      ],
      specifier: "/s/x.js",
    });
    expect(text).toBe(`import{default as D,a,b as c}from"/s/x.js";`);
    expect(
      parseStatementBindings(text.slice(0, text.indexOf('"') + 1)).named,
    ).toEqual([
      { imported: "default", local: "D" },
      { imported: "a", local: "a" },
      { imported: "b", local: "c" },
    ]);
  });

  test("re-exports may spell a string name", () => {
    expect(
      renderStatement({
        reexport: true,
        bindings: [{ imported: "a", local: "a-b" }],
        specifier: "/s/x.js",
      }),
    ).toBe(`export{a as "a-b"}from"/s/x.js";`);
  });
});
