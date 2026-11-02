import { describe, expect, test } from "bun:test";
import { testPlace } from "@plugins/apps/plugins/places/plugins/places-core/core/testing";
import type { LocatedPlace } from "@plugins/page/plugins/place/core";
import { joinPageOverlay } from "./join";

function located(
  blockId: string,
  placeId: string,
  over: Partial<LocatedPlace> = {},
): LocatedPlace {
  return {
    blockId,
    providerId: "google",
    placeId,
    name: `name ${placeId}`,
    address: `address ${placeId}`,
    category: undefined,
    kind: undefined,
    family: undefined,
    position: { lat: 1, lng: 2 },
    ...over,
  };
}

describe("joinPageOverlay", () => {
  test("numbers the Google places 1…N in page order", () => {
    const { items } = joinPageOverlay(
      {
        located: [
          located("b1", "g1"),
          located("b2", "g2"),
          located("b3", "g3"),
        ],
        unplaced: 0,
      },
      [],
    );
    expect(items.map((i) => [i.n, i.blockId])).toEqual([
      [1, "b1"],
      [2, "b2"],
      [3, "b3"],
    ]);
  });

  test("matches a saved place by its Google id", () => {
    const saved = testPlace({ googlePlaceId: "g2" });
    const { items } = joinPageOverlay(
      { located: [located("b1", "g1"), located("b2", "g2")], unplaced: 0 },
      [saved, testPlace({ googlePlaceId: null })],
    );
    expect(items[0]!.saved).toBeNull();
    expect(items[1]!.saved).toBe(saved);
  });

  test("leaves other providers out, counted as unplaced, without a gap in the numbers", () => {
    const { items, unplaced } = joinPageOverlay(
      {
        located: [
          located("b1", "g1"),
          located("b2", "osm-1", { providerId: "osm" }),
          located("b3", "x", { providerId: undefined }),
          located("b4", "g4"),
        ],
        unplaced: 2,
      },
      [],
    );
    expect(items.map((i) => [i.n, i.blockId])).toEqual([
      [1, "b1"],
      [2, "b4"],
    ]);
    expect(unplaced).toBe(4);
  });

  test("names an unnamed block after the saved place, else its address", () => {
    const saved = testPlace({ googlePlaceId: "g1", name: "Saved name" });
    const { items } = joinPageOverlay(
      {
        located: [
          located("b1", "g1", { name: undefined }),
          located("b2", "g2", { name: undefined }),
        ],
        unplaced: 0,
      },
      [saved],
    );
    expect(items.map((i) => i.name)).toEqual(["Saved name", "address g2"]);
  });
});
