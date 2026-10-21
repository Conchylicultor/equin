import { describe, expect, test } from "bun:test";
import type {
  PrototypeHistory,
  PrototypeOption,
  PrototypeVersion,
} from "@plugins/apps/plugins/prototypes/plugins/files/core";
import {
  declaresVariant,
  isPastStep,
  versionForStep,
  stepBy,
  stepLabel,
  versionSteps,
  type VersionStep,
} from "./version-steps";

function version(n: number): PrototypeVersion {
  return {
    n,
    sha: `sha${n}`,
    at: "2026-09-11T10:00:00.000Z",
    kind: n === 0 ? "baseline" : "turn",
    subject: `request ${n}`,
    conversationId: null,
    messageId: null,
    options: [],
  };
}

function shaOf(step: VersionStep): string | null {
  return versionForStep(step)?.sha ?? null;
}

function history(count: number, dirty: boolean): PrototypeHistory {
  return {
    versions: Array.from({ length: count }, (_, i) => version(i)),
    dirty,
  };
}

function labels(h: PrototypeHistory, shown: string | null = null): string[] {
  const model = versionSteps(h, shown);
  return model.steps.map((s) => stepLabel(s, model.newestN));
}

describe("versionSteps", () => {
  test("clean: one stop per version, the newest is live", () => {
    const model = versionSteps(history(3, false), null);
    expect(labels(history(3, false))).toEqual([
      "v0 of 2",
      "v1 of 2",
      "v2 · Latest",
    ]);
    expect(model.current).toBe(2);
    expect(model.steps.map(shaOf)).toEqual(["sha0", "sha1", null]);
  });

  test("dirty: an unsaved stop past the newest, which becomes a past version", () => {
    const model = versionSteps(history(3, true), null);
    expect(labels(history(3, true))).toEqual([
      "v0 of 2",
      "v1 of 2",
      "v2 of 2",
      "Live · unsaved",
    ]);
    expect(model.current).toBe(3);
    expect(model.steps.map(shaOf)).toEqual(["sha0", "sha1", "sha2", null]);
    expect(model.steps.map(isPastStep)).toEqual([true, true, true, false]);
  });

  test("only the baseline: one live stop, no way to step", () => {
    const model = versionSteps(history(1, false), null);
    expect(labels(history(1, false))).toEqual(["v0 · Latest"]);
    expect(stepBy(model, -1)).toBeNull();
    expect(stepBy(model, 1)).toBeNull();
  });

  test("a shown sha lands on its own stop", () => {
    const model = versionSteps(history(4, false), "sha1");
    expect(model.current).toBe(1);
    const prev = stepBy(model, -1);
    const next = stepBy(model, 1);
    expect(prev && shaOf(prev)).toBe("sha0");
    expect(next && shaOf(next)).toBe("sha2");
  });

  test("showing the newest of a clean folder IS the live stop", () => {
    const model = versionSteps(history(3, false), "sha2");
    expect(model.current).toBe(2);
    expect(isPastStep(model.steps[2]!)).toBe(false);
  });

  test("showing the newest of a dirty folder steps forward to unsaved", () => {
    const model = versionSteps(history(3, true), "sha2");
    expect(model.current).toBe(2);
    const next = stepBy(model, 1);
    expect(next?.kind).toBe("unsaved");
    expect(next && shaOf(next)).toBeNull();
  });

  test("a sha the history does not hold is lost; forward returns to live", () => {
    const model = versionSteps(history(3, true), "gone");
    expect(model.current).toBeNull();
    expect(stepBy(model, -1)).toBeNull();
    expect(stepBy(model, 1)?.kind).toBe("unsaved");
  });

  test("the ends are closed", () => {
    const first = versionSteps(history(3, false), "sha0");
    expect(stepBy(first, -1)).toBeNull();
    const last = versionSteps(history(3, false), null);
    expect(stepBy(last, 1)).toBeNull();
  });

  test("an empty history is a broken store, not zero versions", () => {
    expect(() => versionSteps({ versions: [], dirty: false }, null)).toThrow();
  });
});

describe("declaresVariant", () => {
  const theme: PrototypeOption = {
    kind: "choice",
    name: "theme",
    values: ["dark", "light"],
    default: "dark",
    group: null,
  };
  const fill: PrototypeOption = {
    kind: "choice",
    name: "fill",
    values: ["empty", "filled"],
    default: "empty",
    group: null,
  };
  const accent: PrototypeOption = {
    kind: "color",
    name: "accent",
    suggestions: [{ name: "sage", color: "#a3c4a0" }],
    default: "#e0ad80",
    group: null,
  };

  test("no picks: every document shows the default variant", () => {
    expect(declaresVariant([], {})).toBe(true);
  });

  test("every picked value declared", () => {
    expect(declaresVariant([theme, fill], { theme: "light" })).toBe(true);
    expect(declaresVariant([accent], { accent: "sage" })).toBe(true);
    expect(declaresVariant([accent], { accent: "#123456" })).toBe(true);
  });

  test("a picked option the document lacks", () => {
    expect(declaresVariant([fill], { theme: "light" })).toBe(false);
  });

  test("a picked value the document does not declare", () => {
    const twoThemes: PrototypeOption = { ...theme, values: ["dark", "dim"] };
    expect(declaresVariant([twoThemes], { theme: "light" })).toBe(false);
    expect(declaresVariant([accent], { accent: "ember" })).toBe(false);
  });

  test("a pick equal to the document's own default", () => {
    const lightFirst: PrototypeOption = { ...theme, default: "light" };
    expect(declaresVariant([lightFirst], { theme: "light" })).toBe(true);
  });
});
