import { describe, expect, test } from "bun:test";
import { readLiveEffect } from "@plugins/network/plugins/live/core";
import {
  patchSavedThemeColorAdjust,
  patchSavedThemeFragment,
  renameSavedTheme,
} from "./endpoints";

const themes: {
  id: string;
  label: string;
  source: string;
  fragments: unknown[];
  colorAdjust?: unknown;
}[] = [
  { id: "custom:a", label: "A", source: "custom", fragments: [] },
  {
    id: "custom:b",
    label: "B",
    source: "custom",
    fragments: [],
    colorAdjust: { hue: 10 },
  },
  { id: "tweakcn:t", label: "T", source: "tweakcn", fragments: [] },
];

function apply(
  def: { effect: unknown },
  params: Record<string, string>,
  body: unknown,
) {
  const [t] = readLiveEffect(def.effect as never).resolve({
    params,
    body,
  }).targets;
  if (t?.kind !== "value") throw new Error("expected a value target");
  expect(t.params).toEqual({});
  return t.apply(themes) as typeof themes;
}

describe("saved-theme edit effects", () => {
  test("rename relabels just that custom theme", () => {
    const next = apply(renameSavedTheme, { id: "custom:a" }, { label: "Z" });
    expect(next.map((t) => t.label)).toEqual(["Z", "B", "T"]);
  });

  test("a read-only theme is left alone", () => {
    const next = apply(renameSavedTheme, { id: "tweakcn:t" }, { label: "Z" });
    expect(next).toEqual(themes);
  });

  test("a fragment edit applies the shared pure edit to that theme only", () => {
    const next = apply(
      patchSavedThemeFragment,
      { id: "custom:a" },
      { groupId: "g", mode: "merge", light: { "--x": "1" }, dark: {} },
    );
    expect(next[0]?.fragments).toEqual([
      { groupId: "g", light: { "--x": "1" }, dark: {} },
    ]);
    expect(next[1]).toEqual(themes[1]!);
  });

  test("a colour adjustment is set, and null clears it", () => {
    const set = apply(
      patchSavedThemeColorAdjust,
      { id: "custom:a" },
      { colorAdjust: { hue: 5 } },
    );
    expect((set[0] as { colorAdjust?: unknown }).colorAdjust).toEqual({
      hue: 5,
    });
    const cleared = apply(
      patchSavedThemeColorAdjust,
      { id: "custom:b" },
      { colorAdjust: null },
    );
    expect("colorAdjust" in cleared[1]!).toBe(false);
  });
});
