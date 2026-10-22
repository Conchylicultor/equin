import { expect, test } from "bun:test";
import type { PlacesSku } from "@plugins/integrations/plugins/google-maps/plugins/places-api/core";
import { detailsTier } from "./details-tier";

const spent =
  (...skus: PlacesSku[]) =>
  (sku: PlacesSku) =>
    !skus.includes(sku);

test("full while its budget lasts, then without the summary, then photos", () => {
  expect(detailsTier(spent())).toBe("full");
  expect(detailsTier(spent("place-details-enterprise-atmosphere"))).toBe(
    "no-summary",
  );
  expect(
    detailsTier(
      spent("place-details-enterprise-atmosphere", "place-details-enterprise"),
    ),
  ).toBe("photos");
});
