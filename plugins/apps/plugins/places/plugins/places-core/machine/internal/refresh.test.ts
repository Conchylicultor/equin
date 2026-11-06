import { expect, test } from "bun:test";
import { PlacesApiError } from "@plugins/integrations/plugins/google-maps/plugins/places-api/core";
import { isPlaceIdObsolete, refreshCutoff, refreshedColumns } from "./refresh";

test("a place is due a refresh 30 days after its last fetch", () => {
  expect(refreshCutoff(new Date("2026-10-31T12:00:00Z")).toISOString()).toBe(
    "2026-10-01T12:00:00.000Z",
  );
});

test("a refresh rewrites Google's name, status, types and link, nulling what Google dropped", () => {
  expect(
    refreshedColumns({
      placeId: "g1",
      name: "Chez X",
      address: "1 rue Y",
      primaryType: "restaurant",
      types: ["restaurant", "food"],
      mapsUrl: "https://maps.google.com/?cid=1",
      businessStatus: "CLOSED_PERMANENTLY",
    }),
  ).toEqual({
    name: "Chez X",
    businessStatus: "CLOSED_PERMANENTLY",
    primaryType: "restaurant",
    types: ["restaurant", "food"],
    mapsUrl: "https://maps.google.com/?cid=1",
    googleLostAt: null,
  });
  expect(
    refreshedColumns({ placeId: "g1", name: "Chez X", address: "1 rue Y" }),
  ).toEqual({
    name: "Chez X",
    businessStatus: null,
    primaryType: null,
    types: [],
    mapsUrl: null,
    googleLostAt: null,
  });
});

test("only Google's NOT_FOUND marks a place id obsolete", () => {
  expect(isPlaceIdObsolete(new PlacesApiError(404, "gone", "NOT_FOUND"))).toBe(
    true,
  );
  expect(
    isPlaceIdObsolete(new PlacesApiError(403, "denied", "PERMISSION_DENIED")),
  ).toBe(false);
  expect(isPlaceIdObsolete(new PlacesApiError(500, "boom"))).toBe(false);
});
