import { describe, expect, it } from "bun:test";
import type { FieldDef, SortRule } from "../../core";
import {
  applyPresetRules,
  presetMatchesRules,
  presetRulesFromLive,
  readSortPresets,
  resolvableRules,
} from "./sort-presets";

describe("readSortPresets", () => {
  it("reads terse authored rows and keeps preset id", () => {
    const presets = readSortPresets([
      {
        id: "p1",
        label: "Priority then due",
        rules: [
          { fieldId: "priority", direction: "desc" },
          { fieldId: "due", direction: "asc" },
        ],
      },
    ]);
    expect(presets).toEqual([
      {
        id: "p1",
        label: "Priority then due",
        rules: [
          { fieldId: "priority", direction: "desc" },
          { fieldId: "due", direction: "asc" },
        ],
      },
    ]);
  });

  it("strips the injected id/rank off rules", () => {
    const presets = readSortPresets([
      {
        id: "p1",
        rank: "a0",
        label: "By name",
        rules: [{ id: "r1", rank: "a0", fieldId: "name", direction: "asc" }],
      },
    ]);
    expect(presets[0]!.rules).toEqual([{ fieldId: "name", direction: "asc" }]);
  });

  it("falls back to an index id when a preset row has no id", () => {
    const presets = readSortPresets([
      { label: "First", rules: [] },
      { label: "Second", rules: [] },
    ]);
    expect(presets.map((p) => p.id)).toEqual(["preset-0", "preset-1"]);
  });

  it("coerces a bad/absent direction to asc and skips ruleless/labelless rows", () => {
    const presets = readSortPresets([
      {
        id: "p1",
        label: "Mixed",
        rules: [{ fieldId: "a" }, { fieldId: "b", direction: "nope" }],
      },
      { id: "p2", rules: [] }, // no label → skipped
      { fieldId: "x" }, // not a preset → skipped
    ]);
    expect(presets).toEqual([
      {
        id: "p1",
        label: "Mixed",
        rules: [
          { fieldId: "a", direction: "asc" },
          { fieldId: "b", direction: "asc" },
        ],
      },
    ]);
  });

  it("tolerates empty / legacy / non-array input", () => {
    expect(readSortPresets(undefined)).toEqual([]);
    expect(readSortPresets(null)).toEqual([]);
    expect(readSortPresets({})).toEqual([]);
    expect(readSortPresets("nope")).toEqual([]);
  });
});

describe("resolvableRules", () => {
  const fields: FieldDef<unknown>[] = [
    { id: "name", label: "Name" },
    { id: "due", label: "Due" },
  ];

  it("filters to rules whose field still resolves, preserving order", () => {
    const rules = [
      { fieldId: "due", direction: "desc" as const },
      { fieldId: "gone", direction: "asc" as const },
      { fieldId: "name", direction: "asc" as const },
    ];
    expect(resolvableRules(rules, fields)).toEqual([
      { fieldId: "due", direction: "desc" },
      { fieldId: "name", direction: "asc" },
    ]);
  });

  it("returns empty when no rule resolves", () => {
    expect(
      resolvableRules([{ fieldId: "gone", direction: "asc" }], fields),
    ).toEqual([]);
  });
});

describe("presetMatchesRules", () => {
  const preset = {
    id: "p1",
    label: "P",
    rules: [
      { fieldId: "a", direction: "asc" as const },
      { fieldId: "b", direction: "desc" as const },
    ],
  };

  it("matches identical ordered rules", () => {
    expect(presetMatchesRules(preset, [...preset.rules])).toBe(true);
  });

  it("rejects different order", () => {
    expect(
      presetMatchesRules(preset, [preset.rules[1]!, preset.rules[0]!]),
    ).toBe(false);
  });

  it("rejects a different direction", () => {
    expect(
      presetMatchesRules(preset, [
        { fieldId: "a", direction: "asc" },
        { fieldId: "b", direction: "asc" },
      ]),
    ).toBe(false);
  });

  it("rejects a different length", () => {
    expect(presetMatchesRules(preset, [preset.rules[0]!])).toBe(false);
  });
});

describe("pinned rules and presets", () => {
  const folders: SortRule = {
    fieldId: "folders",
    direction: "asc",
    pinned: true,
  };
  const fields: FieldDef<unknown>[] = [
    { id: "folders", label: "Folders", value: () => 0 },
    { id: "modified", label: "Modified", value: () => 0 },
    { id: "name", label: "Name", value: () => "" },
  ];

  it("saving strips pinned rules and the pinned flag", () => {
    expect(
      presetRulesFromLive([
        folders,
        { fieldId: "modified", direction: "desc" },
      ]),
    ).toEqual([{ fieldId: "modified", direction: "desc" }]);
  });

  it("applying keeps the pinned prefix, dropping preset rules on pinned fields", () => {
    expect(
      applyPresetRules(
        [folders, { fieldId: "name", direction: "asc" }],
        [
          { fieldId: "folders", direction: "desc" },
          { fieldId: "modified", direction: "desc" },
          { fieldId: "gone", direction: "asc" },
        ],
        fields,
      ),
    ).toEqual([folders, { fieldId: "modified", direction: "desc" }]);
  });

  it("matches a preset against the user rules only", () => {
    const preset = {
      id: "p",
      label: "Newest",
      rules: [{ fieldId: "modified", direction: "desc" as const }],
    };
    expect(
      presetMatchesRules(preset, [
        folders,
        { fieldId: "modified", direction: "desc" },
      ]),
    ).toBe(true);
    expect(presetMatchesRules(preset, [folders])).toBe(false);
  });
});
