import { describe, expect, test } from "bun:test";
import { parseSavedSymbolName } from "@plugins/ui/plugins/icons/plugins/saved-names/core";
import { parseIconAnswer } from "./icon-answer";

describe("parseIconAnswer", () => {
  test("takes ICON in the installed spelling", () => {
    expect(parseIconAnswer("ICON: bug_report\nALT: pest_control")).toEqual({
      ok: true,
      icon: parseSavedSymbolName("bug-report"),
    });
  });

  test("falls back to ALT when ICON is no symbol", () => {
    expect(parseIconAnswer("ICON: not_a_symbol_xyz\nALT: speed")).toEqual({
      ok: true,
      icon: parseSavedSymbolName("speed"),
    });
  });

  test("is unusable with neither", () => {
    expect(parseIconAnswer("I think a bug").ok).toBe(false);
  });
});
