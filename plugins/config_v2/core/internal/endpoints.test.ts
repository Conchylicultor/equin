import { describe, expect, test } from "bun:test";
import { readLiveEffect } from "@plugins/network/plugins/live/core";
import {
  forkDescriptorScope,
  removeDescriptorScope,
  setConfigField,
} from "./endpoints";

function valueTargets(
  effect: Parameters<typeof readLiveEffect>[0],
  body: unknown,
) {
  return readLiveEffect(effect)
    .resolve({ params: {}, body })
    .targets.map((t) => {
      if (t.kind !== "value") throw new Error("value target");
      return t;
    });
}

describe("setConfigField effect", () => {
  const body = { storePath: "a/b", key: "k", value: 2 };

  test("patches the document, its tiers and a hash conflict's override", () => {
    const [values, tiers, conflict] = valueTargets(setConfigField.effect, body);
    expect(values?.key).toBe("config-v2.values");
    expect(values?.params).toEqual({ path: "a/b" });
    expect(values?.apply({ k: 1, other: 0 })).toEqual({ k: 2, other: 0 });
    expect(tiers?.key).toBe("config-v2.tiers");
    expect(tiers?.apply({ k: "default" })).toEqual({ k: "user" });
    expect(conflict?.key).toBe("config-v2.conflicts");
    expect(conflict?.apply(null)).toBeNull();
    const hash = {
      kind: "hash",
      originValues: { k: 0 },
      overrideValues: { k: 1 },
    };
    expect(conflict?.apply(hash)).toEqual({
      ...hash,
      overrideValues: { k: 2 },
    });
    const invalid = { ...hash, kind: "invalid" };
    expect(conflict?.apply(invalid)).toEqual(invalid);
  });

  test("a scoped write names the scope's tuple", () => {
    const [values] = valueTargets(setConfigField.effect, {
      ...body,
      scopeId: "app:x",
    });
    expect(values?.params).toEqual({ path: "a/b", scopeId: "app:x" });
  });
});

describe("descriptor scope effects", () => {
  test("fork adds the scope once; remove drops it", () => {
    const body = { storePath: "a/b", scopeId: "app:x" };
    const [fork] = valueTargets(forkDescriptorScope.effect, body);
    expect(fork?.apply({ "a/b": ["app:y"] })).toEqual({
      "a/b": ["app:y", "app:x"],
    });
    expect(fork?.apply({ "a/b": ["app:x"] })).toEqual({ "a/b": ["app:x"] });
    const [remove] = valueTargets(removeDescriptorScope.effect, body);
    expect(remove?.apply({ "a/b": ["app:x", "app:y"] })).toEqual({
      "a/b": ["app:y"],
    });
  });
});
