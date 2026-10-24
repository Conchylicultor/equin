import { describe, expect, test } from "bun:test";
import {
  SUB_THEME_CALL,
  readSubThemeId,
  uncontributedSubThemes,
} from "./uncontributed";

const SOURCE = [
  'import { both, defineSubTheme } from "x";',
  "",
  "export const a = defineSubTheme({",
  '  id: "home-new-app-prompt",',
  '  label: "New app prompt",',
  "  fragments: [],",
  "});",
  'export const b = defineSubTheme({ id: "other", label: "Other", fragments: [] });',
].join("\n");

describe("SUB_THEME_CALL", () => {
  test("matches a call, not the function's declaration", () => {
    expect(SUB_THEME_CALL.test("const a = defineSubTheme({")).toBe(true);
    expect(SUB_THEME_CALL.test("export function defineSubTheme(def: {")).toBe(
      false,
    );
  });
});

describe("readSubThemeId", () => {
  test("reads the id of the call on a line, across lines", () => {
    expect(readSubThemeId(SOURCE, 3)).toBe("home-new-app-prompt");
    expect(readSubThemeId(SOURCE, 8)).toBe("other");
  });

  test("an id that is not the leading literal key is unreadable", () => {
    const src =
      "const x = defineSubTheme({ label: 'L', id: ID, fragments: [] });";
    expect(readSubThemeId(src, 1)).toBeUndefined();
  });
});

describe("uncontributedSubThemes", () => {
  const declared = [
    { id: "home-new-app-prompt", path: "p/theme.ts", line: 3 },
    { id: "other", path: "p/theme.ts", line: 8 },
  ];

  test("a declared sub-theme no contribution paints is reported", () => {
    expect(
      uncontributedSubThemes(declared, new Set(["other"])).map((d) => d.id),
    ).toEqual(["home-new-app-prompt"]);
  });

  test("every declared sub-theme contributed passes", () => {
    expect(
      uncontributedSubThemes(
        declared,
        new Set(["home-new-app-prompt", "other"]),
      ),
    ).toEqual([]);
  });
});
