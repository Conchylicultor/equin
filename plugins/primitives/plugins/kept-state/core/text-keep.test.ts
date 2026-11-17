import { describe, expect, test } from "bun:test";
import {
  isTransient,
  keptField,
  keptText,
  resolveTextKeep,
  transient,
  type KeptBinding,
} from "./text-keep";

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
    const seen: string[] = [];
    const binding: KeptBinding<string> = [
      "draft",
      (v) => seen.push(typeof v === "function" ? v("") : v),
      () => {},
      {
        current: () => "draft",
        flush: () => {},
        showInitial: () => {},
        clearIfStill: () => {},
      },
    ];
    expect(isTransient(binding)).toBe(false);
    const kept = resolveTextKeep(binding);
    expect(kept?.value).toBe("draft");
    kept?.set("next");
    expect(seen).toEqual(["next"]);
  });

  test("a primitive's own kept text drives the field", () => {
    const seen: string[] = [];
    const kept = resolveTextKeep(keptText("x", (v) => seen.push(v)));
    expect(kept?.value).toBe("x");
    kept?.set("y");
    expect(seen).toEqual(["y"]);
  });

  test("one string field of a kept object is kept text over the object", () => {
    let obj = { text: "hi", picked: 3 };
    const binding: KeptBinding<typeof obj> = [
      obj,
      (a) => {
        obj = typeof a === "function" ? a(obj) : a;
      },
      () => {},
      {
        current: () => obj,
        flush: () => {},
        showInitial: () => {},
        clearIfStill: () => {},
      },
    ];
    const kept = resolveTextKeep(keptField(binding, "text"));
    expect(kept?.value).toBe("hi");
    kept?.set("hello");
    expect(obj).toEqual({ text: "hello", picked: 3 });
  });
});
