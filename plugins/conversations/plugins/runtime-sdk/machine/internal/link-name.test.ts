import { describe, expect, test } from "bun:test";
import { linkName } from "./link-name";

describe("linkName", () => {
  test("title · id", () => {
    expect(linkName("Fix login bug", "conv-1")).toBe("Fix login bug · conv-1");
  });

  test("no title is the id alone", () => {
    expect(linkName(null, "conv-1")).toBe("conv-1");
    expect(linkName("  \n ", "conv-1")).toBe("conv-1");
  });

  test("path separators, colons and control characters become spaces", () => {
    expect(linkName("a/b:c\td\n\ne", "conv-1")).toBe("a b c d e · conv-1");
  });

  test("never a hidden file", () => {
    expect(linkName("..hidden", "conv-1")).toBe("hidden · conv-1");
  });

  test("a long title is cut on a character, under 255 bytes", () => {
    const name = linkName("é".repeat(200), "conv-1");
    expect(name.endsWith("… · conv-1")).toBe(true);
    expect(name).not.toContain("�");
    expect(new TextEncoder().encode(name).length).toBeLessThan(255);
  });
});
