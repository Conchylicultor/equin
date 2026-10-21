import { describe, expect, test } from "bun:test";
import { unknownPicks } from "./picks";

describe("unknownPicks", () => {
  test("names only the ids no search returned", () => {
    const known = new Set(["a", "b"]);
    expect(
      unknownPicks(
        [
          { googlePlaceId: "a", why: "x" },
          { googlePlaceId: "z", why: "y" },
        ],
        known,
      ),
    ).toEqual(["z"]);
  });
  test("no picks is never unknown", () => {
    expect(unknownPicks([], new Set())).toEqual([]);
  });
});
