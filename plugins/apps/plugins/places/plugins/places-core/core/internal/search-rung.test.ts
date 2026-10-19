import { expect, test } from "bun:test";
import type { PlacesSku } from "@plugins/integrations/plugins/google-maps/plugins/places-api/core";
import { searchRung } from "./search-rung";

const spent =
  (...skus: PlacesSku[]) =>
  (sku: PlacesSku) =>
    !skus.includes(sku);

test("rich while the Enterprise budget lasts, then basic, then names", () => {
  expect(searchRung(spent())).toBe("rich");
  expect(searchRung(spent("text-search-enterprise"))).toBe("basic");
  expect(searchRung(spent("text-search-enterprise", "text-search-pro"))).toBe(
    "names",
  );
});
