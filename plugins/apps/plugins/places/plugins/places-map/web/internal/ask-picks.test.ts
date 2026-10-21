import { describe, expect, test } from "bun:test";
import type { PlaceCandidate } from "@plugins/integrations/plugins/google-maps/plugins/places-api/core";
import { mapPicksOf, type AskResult } from "./ask-picks";

function candidate(placeId: string): PlaceCandidate {
  return { placeId, name: placeId, lat: 48.86, lng: 2.35, types: [] };
}

const CANDIDATES = Object.fromEntries(
  ["a", "b", "c", "d"].map((id) => [id, candidate(id)]),
);

function result(toolUseId: string, ids: string[]): AskResult {
  return {
    toolUseId,
    payload: {
      picks: ids.map((googlePlaceId) => ({ googlePlaceId, why: "fits" })),
    },
  };
}

const ids = (picks: ReturnType<typeof mapPicksOf>) =>
  picks.map((p) => [p.hit.placeId, p.n]);

describe("mapPicksOf", () => {
  const results = [result("t1", ["a", "b"]), result("t2", ["c", "a"])];

  test("the map shows the current (newest) result only", () => {
    expect(ids(mapPicksOf(results, new Set(), CANDIDATES, null, []))).toEqual([
      ["c", 1],
      ["a", 2],
    ]);
  });

  test("an expanded earlier result joins, a place picked twice keeps its newest pick", () => {
    expect(
      ids(mapPicksOf(results, new Set(["t1"]), CANDIDATES, null, [])),
    ).toEqual([
      ["c", 1],
      ["a", 2],
      ["b", 2],
    ]);
  });

  test("a pick whose candidate has not landed is left out", () => {
    expect(
      ids(
        mapPicksOf(
          [result("t1", ["a", "zz"])],
          new Set(),
          CANDIDATES,
          null,
          [],
        ),
      ),
    ).toEqual([["a", 1]]);
  });

  test("no results, no pins", () => {
    expect(mapPicksOf([], new Set(), CANDIDATES, null, [])).toEqual([]);
  });
});
