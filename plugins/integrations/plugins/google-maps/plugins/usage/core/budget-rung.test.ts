import { expect, test } from "bun:test";
import type { PlacesSku } from "@plugins/integrations/plugins/google-maps/plugins/places-api/core";
import { budgetRung } from "./budget-rung";

const ladder = [
  { rung: "rich", sku: "text-search-enterprise" },
  { rung: "basic", sku: "text-search-pro" },
] as const;
const spent =
  (...skus: PlacesSku[]) =>
  (sku: PlacesSku) =>
    !skus.includes(sku);

test("the first step within budget, else the floor", () => {
  expect(budgetRung(ladder, "names", spent())).toBe("rich");
  expect(budgetRung(ladder, "names", spent("text-search-enterprise"))).toBe(
    "basic",
  );
  // A richer step spent does not hide a cheaper one; both spent is the floor.
  expect(budgetRung(ladder, "names", spent("text-search-pro"))).toBe("rich");
  expect(
    budgetRung(
      ladder,
      "names",
      spent("text-search-enterprise", "text-search-pro"),
    ),
  ).toBe("names");
});
