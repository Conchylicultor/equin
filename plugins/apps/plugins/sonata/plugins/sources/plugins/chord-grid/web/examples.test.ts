import { describe, expect, it } from "bun:test";
import { PLACEHOLDER_TEXT, STARTER_TEXT } from "./examples";
import { parseGrid } from "./parse-grid";

describe("chord-grid examples", () => {
  it.each([
    ["starter", STARTER_TEXT],
    ["placeholder", PLACEHOLDER_TEXT],
  ])("the %s parses with nothing skipped", (_, text) => {
    const { events, skipped } = parseGrid(text);
    expect(skipped).toEqual([]);
    expect(events.length).toBeGreaterThan(0);
  });
});
