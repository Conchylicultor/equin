import { describe, expect, test } from "bun:test";
import { assertChangelogRetained } from "./changelog-retention";

describe("assertChangelogRetained", () => {
  test("a serving host with something pruning the changelog passes", () => {
    expect(() =>
      assertChangelogRetained([{ reason: "L2 prunes it" }]),
    ).not.toThrow();
  });

  test("a serving host with nothing pruning the changelog fails loudly", () => {
    expect(() => assertChangelogRetained([])).toThrow(
      /no ChangelogRetention contribution, so nothing prunes `live_state_changelog`/,
    );
  });
});
