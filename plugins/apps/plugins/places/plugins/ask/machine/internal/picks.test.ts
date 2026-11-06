import { describe, expect, test } from "bun:test";
import { picksWithoutAbout, unknownPicks } from "./picks";

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

describe("picksWithoutAbout", () => {
  test("names the picks with no about, or a blank one", () => {
    expect(
      picksWithoutAbout([
        { googlePlaceId: "a", why: "x", about: "Famous for its tonkotsu." },
        { googlePlaceId: "b", why: "y" },
        { googlePlaceId: "c", why: "z", about: "  " },
      ]),
    ).toEqual(["b", "c"]);
  });
});
