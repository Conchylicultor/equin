import { describe, expect, it } from "bun:test";
import { LocationSchema, locationLabel } from "./location";

describe("locationLabel", () => {
  it("prefers the address", () => {
    expect(locationLabel({ lat: 1, lng: 2, address: "1 Main St" })).toBe(
      "1 Main St",
    );
  });
  it("falls back to lat, lng with 4 decimals", () => {
    expect(locationLabel({ lat: 48.85661, lng: 2.3522 })).toBe(
      "48.8566, 2.3522",
    );
    expect(locationLabel({ lat: 1, lng: 2, address: "" })).toBe(
      "1.0000, 2.0000",
    );
  });
});

describe("LocationSchema", () => {
  it("accepts a point with or without an address", () => {
    expect(LocationSchema.safeParse({ lat: 1, lng: 2 }).success).toBe(true);
    expect(
      LocationSchema.safeParse({ lat: 1, lng: 2, address: "x" }).success,
    ).toBe(true);
  });
  it("rejects out-of-range or malformed points", () => {
    expect(LocationSchema.safeParse({ lat: 91, lng: 0 }).success).toBe(false);
    expect(LocationSchema.safeParse({ lat: 0, lng: 181 }).success).toBe(false);
    expect(LocationSchema.safeParse({ lat: "1", lng: 0 }).success).toBe(false);
  });
});
