import { describe, expect, test } from "bun:test";
import {
  isTransient,
  keptField,
  keptItem,
  keptPart,
  resolveTextKeep,
  transient,
  type KeptBinding,
  type KeptHandle,
} from "./text-keep";

/** A binding over a plain variable — as `useKept` would mint it. */
function binding<T>(initial: T): { b: () => KeptBinding<T>; get: () => T } {
  let value = initial;
  const handle = {
    current: () => value,
    flush: () => {},
    showInitial: () => {},
    clearIfStill: () => {},
  } as unknown as KeptHandle<T>;
  return {
    b: () => [
      value,
      (a) => {
        value = typeof a === "function" ? (a as (p: T) => T)(value) : a;
      },
      () => {},
      handle,
    ],
    get: () => value,
  };
}

describe("text keep", () => {
  test("transient carries its reason and resolves to the caller's own value", () => {
    const keep = transient("secret");
    expect(isTransient(keep)).toBe(true);
    expect(keep.reason).toBe("secret");
    expect(resolveTextKeep(keep)).toBeNull();
  });

  test("transient refuses an empty reason", () => {
    expect(() => transient("  ")).toThrow();
  });

  test("a binding drives the field: its value, its setter", () => {
    const s = binding("draft");
    expect(isTransient(s.b())).toBe(false);
    const kept = resolveTextKeep(s.b());
    expect(kept?.value).toBe("draft");
    kept?.set("next");
    expect(s.get()).toBe("next");
  });

  test("a binding as a part drives the field", () => {
    const s = binding("x");
    const kept = resolveTextKeep(keptPart(s.b()));
    expect(kept?.value).toBe("x");
    kept?.set("y");
    expect(s.get()).toBe("y");
  });

  test("one string field of a kept object is kept text over the object", () => {
    const s = binding({ text: "hi", picked: 3 });
    const kept = resolveTextKeep(keptField(s.b(), "text"));
    expect(kept?.value).toBe("hi");
    kept?.set("hello");
    expect(s.get()).toEqual({ text: "hello", picked: 3 });
  });

  test("a field of one item of a kept list writes into that item only", () => {
    const s = binding({
      cards: [
        { id: "a", text: "one" },
        { id: "b", text: "two" },
      ],
    });
    const card = keptItem(keptField(s.b(), "cards"), (c) => c.id === "b");
    expect(card.value).toEqual({ id: "b", text: "two" });
    const kept = resolveTextKeep(keptField(card, "text"));
    expect(kept?.value).toBe("two");
    kept?.set("deux");
    expect(s.get()).toEqual({
      cards: [
        { id: "a", text: "one" },
        { id: "b", text: "deux" },
      ],
    });
  });

  test("a part's functional set sees the latest value", () => {
    const s = binding({ n: 1 });
    const n = keptField(s.b(), "n");
    n.set((p) => p + 1);
    n.set((p) => p + 1);
    expect(s.get()).toEqual({ n: 3 });
  });

  test("an item is found by identity: a write after a reorder reaches it", () => {
    const s = binding([
      { id: "a", text: "one" },
      { id: "b", text: "two" },
    ]);
    const b = keptField(
      keptItem(s.b(), (c) => c.id === "b"),
      "text",
    );
    s.b()[1]((prev) => [prev[1]!, prev[0]!]);
    b.set("deux");
    expect(s.get()).toEqual([
      { id: "b", text: "deux" },
      { id: "a", text: "one" },
    ]);
  });

  test("a write to an item removed since takes no write", () => {
    const s = binding([{ id: "a", text: "one" }]);
    const a = keptField(
      keptItem(s.b(), (c) => c.id === "a"),
      "text",
    );
    s.b()[1]([]);
    a.set("gone");
    expect(s.get()).toEqual([]);
  });

  test("a list's items are keptItem's, never a field", () => {
    const s = binding([{ id: "a" }]);
    // @ts-expect-error — a list is not an object to spread a field into
    expect(() => keptField(s.b(), 0)).toBeDefined();
  });

  test("a list nothing matches is refused", () => {
    const s = binding(["a"]);
    expect(() => keptItem(s.b(), (x) => x === "b")).toThrow();
  });
});
