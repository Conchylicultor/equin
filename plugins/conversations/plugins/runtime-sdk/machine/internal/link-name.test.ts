import { describe, expect, test } from "bun:test";
import { linkName } from "./link-name";

describe("linkName", () => {
  test("equin · id · title", () => {
    expect(linkName("Fix login bug", "conv-1")).toBe(
      "equin · conv-1 · Fix login bug",
    );
  });

  test("no title is the id alone", () => {
    expect(linkName(null, "conv-1")).toBe("equin · conv-1");
    expect(linkName("  \n ", "conv-1")).toBe("equin · conv-1");
  });

  test("path separators, colons and control characters become spaces", () => {
    expect(linkName("a/b:c\td\n\ne", "conv-1")).toBe(
      "equin · conv-1 · a b c d e",
    );
  });

  test("a leading dot in the title stays — the name starts with equin", () => {
    expect(linkName("..hidden", "conv-1")).toBe("equin · conv-1 · ..hidden");
  });

  test("a long title is cut on a character, under 255 bytes", () => {
    const name = linkName("é".repeat(200), "conv-1");
    expect(name.startsWith("equin · conv-1 · ")).toBe(true);
    expect(name.endsWith("…")).toBe(true);
    expect(name).not.toContain("�");
    expect(new TextEncoder().encode(name).length).toBeLessThan(255);
  });
});
