import { describe, expect, it } from "bun:test";
import type { VariantValue } from "@plugins/fields/plugins/variant/core";
import { encodeViewAddress, parseViewAddress } from "./view-address";

const v = (value: Record<string, unknown>) =>
  ({ type: "list", ...value }) as VariantValue;

describe("encodeViewAddress / parseViewAddress", () => {
  it("spells a view with no draft as its bare id", () => {
    expect(encodeViewAddress("failures", null)).toBe("failures");
    expect(parseViewAddress("failures")).toEqual({
      viewId: "failures",
      draft: { kind: "none" },
    });
  });

  it("round-trips a draft, unicode included", () => {
    const draft = v({ filter: { tag: "café ✓ 日本" }, sort: [1] });
    const address = encodeViewAddress("b", draft);
    expect(address.startsWith("b~")).toBe(true);
    expect(parseViewAddress(address)).toEqual({
      viewId: "b",
      draft: { kind: "view", view: draft },
    });
  });

  it("needs no URL escaping", () => {
    const address = encodeViewAddress("b", v({ q: "?&=;/+ é" }));
    expect(encodeURIComponent(address)).toBe(address);
  });

  it("is canonical: key order and undefined members do not change it", () => {
    expect(encodeViewAddress("b", v({ a: 1, b: { d: 2, c: undefined } }))).toBe(
      encodeViewAddress("b", { b: { d: 2 }, a: 1, type: "list" } as never),
    );
  });

  it("reads a draft part that does not decode as malformed", () => {
    const notJson = encodeViewAddress("b", v({})).replace(
      /~.*/,
      "~bm90IGpzb24",
    );
    for (const value of [
      "b~",
      "b~***",
      "b~A",
      notJson,
      // `[1]` — JSON, but not a view value.
      "b~WzFd",
      // A lone 0xff byte — not UTF-8.
      "b~_w",
    ]) {
      expect(parseViewAddress(value)).toEqual({
        viewId: "b",
        draft: { kind: "malformed" },
      });
    }
  });

  it("refuses a view id holding the separator", () => {
    expect(() => encodeViewAddress("a~b", null)).toThrow(/separator/);
  });
});
