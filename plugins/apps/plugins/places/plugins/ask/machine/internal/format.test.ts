import { describe, expect, test } from "bun:test";
import { candidateLine, searchAnswer } from "./format";

const base = { placeId: "p1", name: "Chez Li", lat: 48.8, lng: 2.3, types: [] };

describe("candidateLine", () => {
  test("keeps the facts a pick is made by", () => {
    expect(
      candidateLine({
        ...base,
        category: "Chinese restaurant",
        rating: 4.56,
        ratingCount: 1200,
        priceLevel: 2,
        businessStatus: "OPERATIONAL",
        hours: { periods: [], weekdayDescriptions: ["Tuesday: 12:00 – 22:30"] },
      }),
    ).toEqual({
      placeId: "p1",
      name: "Chez Li",
      type: "Chinese restaurant",
      rating: "4.6★ from 1200 reviews",
      price: "€€",
      hours: ["Tuesday: 12:00 – 22:30"],
    });
  });
  test("a closed place says so", () => {
    expect(
      candidateLine({ ...base, businessStatus: "CLOSED_PERMANENTLY" }).status,
    ).toBe("CLOSED_PERMANENTLY");
  });
});

describe("searchAnswer", () => {
  test("a basic answer says what it lacks", () => {
    expect(searchAnswer([base], "basic")).toContain("no rating");
  });
  test("nothing found", () => {
    expect(searchAnswer([], "rich")).toBe("No places found.");
  });
});
