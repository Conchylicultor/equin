import { describe, expect, test } from "bun:test";
import { inputSummary } from "./input-summary";

describe("inputSummary", () => {
  test("a salient field wins, in rank order, whatever the key order", () => {
    expect(
      inputSummary({ track: "main", description: "", title: "Fix the card" }),
    ).toBe("Fix the card");
    expect(inputSummary({ title: "T", description: "D" })).toBe("D");
  });

  test("only the first line of a multi-line field", () => {
    expect(inputSummary({ command: "\n  ls -la\nrm x" })).toBe("ls -la");
  });

  test("an unknown tool: its first short string field", () => {
    expect(inputSummary({ n: 3, body: "x".repeat(500), label: "hi" })).toBe(
      "hi",
    );
  });

  test("nothing to say: no object, or no text in it", () => {
    expect(inputSummary(null)).toBeUndefined();
    expect(inputSummary("x")).toBeUndefined();
    expect(inputSummary(["x"])).toBeUndefined();
    expect(inputSummary({ n: 1, flag: true, s: " " })).toBeUndefined();
  });
});
