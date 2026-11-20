import { describe, expect, it } from "bun:test";
import { CODE, factJson, factOf, NotDataError, type Fact } from "./fact";

describe("factOf", () => {
  it("keeps data, marks code, drops bookkeeping and undefined, sorts keys", () => {
    class Store {
      value = 1;
    }
    const fact = factOf(
      {
        _slot: () => null,
        _pluginId: "p",
        title: "Mail",
        icon: { kind: "symbol", name: "mail" },
        component: () => null,
        element: { $$typeof: Symbol.for("react.element") },
        schema: { _zod: {} },
        store: new Store(),
        tags: ["a", 1, true, null],
        nested: { label: "x", run: () => 1 },
        missing: undefined,
      },
      "entry",
    );
    expect(fact).toEqual({
      component: CODE,
      element: CODE,
      icon: { kind: "symbol", name: "mail" },
      nested: { label: "x", run: CODE },
      schema: CODE,
      store: CODE,
      tags: ["a", 1, true, null],
      title: "Mail",
    });
    expect(Object.keys(fact)).toEqual([...Object.keys(fact)].sort());
  });

  it("is canonical: key order does not change the JSON", () => {
    expect(factJson({ b: 1, a: { d: 2, c: 3 } }, "e")).toBe(
      factJson({ a: { c: 3, d: 2 }, b: 1 }, "e"),
    );
  });

  it("refuses what is neither data nor code, naming where", () => {
    expect(() => factOf({ n: Number.NaN }, "entry")).toThrow(NotDataError);
    expect(() => factOf({ list: [1, undefined] }, "entry")).toThrow(
      "entry.list[1]",
    );
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => factOf({ cyclic }, "entry")).toThrow("a cycle");
  });

  it("writes a getter that throws when read as code (as the build's record does)", () => {
    const field = {
      id: "uuid",
      get defaultValue(): string {
        throw new Error("no default");
      },
    };
    expect(factOf({ field }, "e")).toEqual({
      field: { defaultValue: CODE, id: "uuid" },
    });
  });
});

// The type twin: a code field does not exist on a fact.
type Entry = {
  title: string;
  component: () => null;
  maybe?: string | (() => string);
  nested: { label: string; run: () => void };
};
type F = Fact<Entry>;
const ok: F = { title: "t", nested: { label: "l" } };
// @ts-expect-error — reading a code field from a fact is a compile error
ok.component;
// @ts-expect-error — nested code fields are gone too
ok.nested.run;
void ok;
