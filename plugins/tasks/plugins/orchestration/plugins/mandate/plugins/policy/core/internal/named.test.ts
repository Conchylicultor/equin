import { describe, expect, test } from "bun:test";
import { defineMandate, mandateKinds } from "./named";

describe("mandateKinds", () => {
  const base = defineMandate({ id: "test-base", label: "Base" });
  const mid = defineMandate({ id: "test-mid", label: "Mid", extends: base });
  const leaf = defineMandate({ id: "test-leaf", label: "Leaf", extends: mid });

  test("a mandate extending nothing is only itself", () => {
    expect(mandateKinds(base)).toEqual([base.id]);
    expect(base.extends).toBeNull();
  });

  test("lists itself, then every mandate it extends, nearest first", () => {
    expect(mandateKinds(leaf)).toEqual([leaf.id, mid.id, base.id]);
  });
});
