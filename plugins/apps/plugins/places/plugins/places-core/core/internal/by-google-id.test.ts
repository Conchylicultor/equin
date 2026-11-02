import { describe, expect, test } from "bun:test";
import { testPlace } from "../testing";
import { placesByGoogleId } from "./by-google-id";

describe("placesByGoogleId", () => {
  test("keys every Google place by its Google id", () => {
    const a = testPlace({ googlePlaceId: "ga" });
    const b = testPlace({ googlePlaceId: "gb" });
    const byId = placesByGoogleId([a, b]);
    expect(byId.size).toBe(2);
    expect(byId.get("ga")).toBe(a);
    expect(byId.get("gb")).toBe(b);
  });

  test("leaves custom places out", () => {
    const custom = testPlace({ googlePlaceId: null });
    expect(placesByGoogleId([custom]).size).toBe(0);
  });
});
