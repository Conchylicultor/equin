import { expect, test } from "bun:test";
import { skuFor } from "./sku";
import { richDetailsSku } from "./rich-details";

test("a mask is billed at its highest field tier", () => {
  expect(skuFor("place-details", "id,photos")).toBe("place-details-ids");
  expect(skuFor("place-details", "id,location,types")).toBe(
    "place-details-essentials",
  );
  expect(skuFor("place-details", "id,displayName,location")).toBe(
    "place-details-pro",
  );
  expect(skuFor("place-details", "id,rating")).toBe("place-details-enterprise");
  expect(skuFor("place-details", "id,rating,editorialSummary")).toBe(
    "place-details-enterprise-atmosphere",
  );
});

test("text search has no Essentials SKU, and sub-fields bill as their parent", () => {
  expect(skuFor("text-search", "places.id")).toBe("text-search-ids");
  expect(skuFor("text-search", "places.id,places.location")).toBe(
    "text-search-pro",
  );
  expect(
    skuFor("text-search", "places.id,places.currentOpeningHours.openNow"),
  ).toBe("text-search-enterprise");
});

test("an unknown field throws rather than guessing its price", () => {
  expect(() => skuFor("place-details", "id,reviews")).toThrow(/reviews/);
});

test("a place card's rich-details tiers step down to free", () => {
  expect(richDetailsSku("full")).toBe("place-details-enterprise-atmosphere");
  expect(richDetailsSku("no-summary")).toBe("place-details-enterprise");
  expect(richDetailsSku("photos")).toBe("place-details-ids");
});
