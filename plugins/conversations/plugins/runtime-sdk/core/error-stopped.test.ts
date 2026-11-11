import { describe, expect, test } from "bun:test";
import { resumeTurnText, USAGE_LIMIT_ERROR } from "./error-stopped";

describe("resumeTurnText", () => {
  test("a usage-limit stop is told the quota is back", () => {
    expect(resumeTurnText(USAGE_LIMIT_ERROR)).toBe(
      "Quota is back — the usage limit that stopped you no longer applies. Continue from where you left off.",
    );
  });

  test("any other stop is told to carry on", () => {
    expect(resumeTurnText("server_error")).toBe(
      "Continue from where you left off.",
    );
    expect(resumeTurnText(null)).toBe("Continue from where you left off.");
  });
});
