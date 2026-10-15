import { expect, test } from "bun:test";
import { refreshCutoff, refreshedColumns } from "./refresh";

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
  });
  expect(
    refreshedColumns({ placeId: "g1", name: "Chez X", address: "1 rue Y" }),
  ).toEqual({
    name: "Chez X",
    businessStatus: null,
    primaryType: null,
    types: [],
    mapsUrl: null,
  });
});
