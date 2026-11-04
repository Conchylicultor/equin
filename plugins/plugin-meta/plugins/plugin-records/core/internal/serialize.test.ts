import { describe, expect, test } from "bun:test";
import { reviveValue, serializeValue, type Json } from "./serialize";

const noSlots = { slot: () => undefined };

function roundTrip(v: unknown, slots?: Map<object, string>): unknown {
  const json = serializeValue(v, {
    slot: (o) => {
      const id = slots?.get(o);
      return id === undefined
        ? undefined
        : { identity: id, meta: { kind: "render" } };
    },
  });
  // What the store holds is JSON text.
  const stored = JSON.parse(JSON.stringify(json)) as Json;
  return reviveValue(stored, {
    slot: (identity, meta) => ({ identity, meta }),
  });
}

describe("serializeValue / reviveValue", () => {
  test("plain data round-trips, undefined fields included", () => {
    const v = { a: 1, b: "x", c: [true, null], d: { e: undefined } };
    const back = roundTrip(v) as typeof v;
    expect(back).toEqual(v);
    expect("e" in back.d).toBe(true);
  });

  test("a function revives as a stand-in with its name, dropped by JSON.stringify", () => {
    function PaneTitle(): null {
      return null;
    }
    const back = roundTrip({ component: PaneTitle }) as {
      component: () => unknown;
    };
    expect(typeof back.component).toBe("function");
    expect(back.component.name).toBe("PaneTitle");
    expect(JSON.stringify(back)).toBe("{}");
    expect(() => back.component()).toThrow(/cannot be called/);
  });

  test("a symbol keeps its description; Map, Set, Date and RegExp keep their kind", () => {
    const back = roundTrip({
      k: Symbol("page.block-data"),
      m: new Map([["x", 1]]),
      s: new Set([1, 2]),
      d: new Date(0),
      r: /a+/g,
    }) as {
      k: symbol;
      m: Map<string, number>;
      s: Set<number>;
      d: Date;
      r: RegExp;
    };
    expect(back.k.description).toBe("page.block-data");
    expect(back.m.get("x")).toBe(1);
    expect([...back.s]).toEqual([1, 2]);
    expect(back.d.getTime()).toBe(0);
    expect(back.r.flags).toBe("g");
  });

  test("a slot is written as its identity and revived through the caller", () => {
    const slot = () => null;
    const back = roundTrip({ _slot: slot }, new Map([[slot, "m.ts#0"]])) as {
      _slot: { identity: string };
    };
    expect(back._slot.identity).toBe("m.ts#0");
  });

  test("what cannot be data throws when read, never reads as absent", () => {
    const zod = { _zod: {}, safeParse: () => ({}) };
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const back = roundTrip({ schema: zod, cyclic }) as {
      schema: { safeParse: unknown };
      cyclic: { self: { x: unknown } };
    };
    expect(() => back.schema.safeParse).toThrow(/zod schema/);
    expect(() => back.cyclic.self.x).toThrow(/cycle/);
  });

  test("a class instance revives as a plain object of its fields", () => {
    class Field {
      meta = { description: "d" };
      defaultValue = 3;
    }
    const back = roundTrip({ f: new Field() }, undefined) as {
      f: { meta: { description: string }; defaultValue: number };
    };
    expect(back.f.meta.description).toBe("d");
    expect(back.f.defaultValue).toBe(3);
  });

  test("serializing never touches a slot's members", () => {
    expect(serializeValue(1, noSlots)).toBe(1);
  });
});
