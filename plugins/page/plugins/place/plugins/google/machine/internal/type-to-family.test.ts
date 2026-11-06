import { describe, expect, test } from "bun:test";
import { GOOGLE_HEADINGS } from "../../shared/google-headings";
import { GOOGLE_TABLE_A } from "../../shared/table-a";
import { GOOGLE_FAMILY_OVERRIDES, googleTypeToFamily } from "./type-to-family";

describe("Table A copy", () => {
  test("files types under every heading", () => {
    const headings = new Set(Object.values(GOOGLE_TABLE_A));
    expect([...headings].sort()).toEqual([...GOOGLE_HEADINGS].sort());
  });

  test("files spot-checked types under Google's headings", () => {
    expect(GOOGLE_TABLE_A.clothing_store).toBe("Shopping");
    expect(GOOGLE_TABLE_A.museum).toBe("Culture");
    expect(GOOGLE_TABLE_A.monument).toBe("Culture");
    expect(GOOGLE_TABLE_A.hotel).toBe("Lodging");
    expect(GOOGLE_TABLE_A.train_station).toBe("Transportation");
    expect(GOOGLE_TABLE_A.stadium).toBe("Sports");
  });
});

describe("family overrides", () => {
  test("only override real Table A types", () => {
    for (const type of Object.keys(GOOGLE_FAMILY_OVERRIDES)) {
      expect(Object.hasOwn(GOOGLE_TABLE_A, type)).toBe(true);
    }
  });

  test("parks are nature, though Google files them under Entertainment", () => {
    expect(GOOGLE_TABLE_A.park).toBe("Entertainment and Recreation");
    expect(googleTypeToFamily("park", ["park"]).family).toBe("nature");
    expect(googleTypeToFamily("tourist_attraction", undefined).family).toBe(
      "entertainment",
    );
  });
});

describe("googleTypeToFamily", () => {
  test("the primary type's heading decides", () => {
    expect(
      googleTypeToFamily("clothing_store", ["clothing_store", "store"]),
    ).toEqual({ family: "shopping", unknownPrimary: undefined });
    expect(googleTypeToFamily("monument", undefined).family).toBe("culture");
  });

  test("the primary type wins over a secondary type with another heading", () => {
    expect(
      googleTypeToFamily("book_store", ["book_store", "cafe"]).family,
    ).toBe("shopping");
  });

  test("a Table B primary falls through to the types, unreported", () => {
    expect(
      googleTypeToFamily("point_of_interest", ["point_of_interest", "park"]),
    ).toEqual({ family: "nature", unknownPrimary: undefined });
  });

  test("a plain address has no family and is not reported", () => {
    expect(googleTypeToFamily("street_address", ["street_address"])).toEqual({
      family: undefined,
      unknownPrimary: undefined,
    });
    expect(googleTypeToFamily(undefined, undefined)).toEqual({
      family: undefined,
      unknownPrimary: undefined,
    });
  });

  test("a primary type in neither table is reported, and the types still decide", () => {
    expect(googleTypeToFamily("spaceport", ["spaceport", "museum"])).toEqual({
      family: "culture",
      unknownPrimary: "spaceport",
    });
  });
});
