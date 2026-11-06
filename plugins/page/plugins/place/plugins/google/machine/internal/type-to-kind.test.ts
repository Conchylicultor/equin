import { describe, expect, test } from "bun:test";
import { googleTypeToKind } from "./type-to-kind";

describe("googleTypeToKind", () => {
  test("maps an exact primary type", () => {
    expect(
      googleTypeToKind("clothing_store", ["clothing_store", "store"]),
    ).toBe("clothing");
    expect(googleTypeToKind("cafe", undefined)).toBe("cafe");
    expect(googleTypeToKind("street_address", [])).toBe("address");
  });

  test("the primary type wins over a more colourful secondary type", () => {
    expect(
      googleTypeToKind("book_store", ["book_store", "cafe", "store"]),
    ).toBe("shop");
  });

  test("falls back to suffix rules for types the table does not list", () => {
    expect(googleTypeToKind("thai_restaurant", undefined)).toBe("restaurant");
    expect(googleTypeToKind("toy_store", undefined)).toBe("shop");
  });

  test("falls back to the first mappable secondary type", () => {
    expect(
      googleTypeToKind("point_of_interest", [
        "point_of_interest",
        "park",
        "establishment",
      ]),
    ).toBe("park");
    expect(googleTypeToKind(undefined, ["establishment", "museum"])).toBe(
      "museum",
    );
  });

  test("an unmappable place has no kind", () => {
    expect(
      googleTypeToKind("point_of_interest", ["establishment"]),
    ).toBeUndefined();
    expect(googleTypeToKind(undefined, undefined)).toBeUndefined();
  });
});
