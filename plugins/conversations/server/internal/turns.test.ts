import { describe, expect, test } from "bun:test";
import { mergeLaunchPrompt } from "./turns";

describe("mergeLaunchPrompt", () => {
  test("keeps the launch prompt (and its preprompt) first", () => {
    expect(
      mergeLaunchPrompt("<special_instructions>x</special_instructions>", "hi"),
    ).toBe("<special_instructions>x</special_instructions>\n\nhi");
    expect(mergeLaunchPrompt(undefined, "hi")).toBe("hi");
    expect(mergeLaunchPrompt("", "hi")).toBe("hi");
  });
});
