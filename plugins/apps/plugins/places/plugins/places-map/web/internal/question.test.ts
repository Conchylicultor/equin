import { describe, expect, test } from "bun:test";
import { looksLikeQuestion } from "./question";

describe("looksLikeQuestion", () => {
  test("a sentence is a question", () => {
    expect(looksLikeQuestion("chinese restaurant open tuesday")).toBe(true);
    expect(looksLikeQuestion("cafe near me")).toBe(true);
    expect(looksLikeQuestion("ramen tonight")).toBe(true);
  });
  test("a name is not", () => {
    expect(looksLikeQuestion("Chez Li")).toBe(false);
    expect(looksLikeQuestion("ramen")).toBe(false);
    expect(looksLikeQuestion("  ")).toBe(false);
  });
});
