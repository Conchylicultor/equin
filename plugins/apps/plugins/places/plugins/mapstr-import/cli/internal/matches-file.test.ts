import { expect, test } from "bun:test";
import type { MapstrPlace } from "./export";
import { markDuplicates, matchRow, resolveRow, rowsFor } from "./matches-file";

const place = (index: number, name: string): MapstrPlace => ({
  index,
  name,
  address: "Paris",
  lat: 48.85,
  lng: 2.35,
  date: "2026-01-01T00:00:00.000Z",
  note: "",
  tags: [".Done"],
});

const matched = (googlePlaceId: string) => ({
  kind: "matched" as const,
  googlePlaceId,
  googleName: googlePlaceId,
  distanceM: 0,
  similarity: 1,
});
const unmatched = { kind: "unmatched" as const, reason: "no results" };

test("the first row resolving to a Google place keeps it; later ones are duplicates", () => {
  const rows = markDuplicates([
    matchRow(place(2, "Umami Canal"), [], matched("g1")),
    matchRow(place(0, "Umami"), [], matched("g1")),
    matchRow(place(1, "Wen Cheng"), [], unmatched),
    // A hand override counts too.
    matchRow(place(3, "Umami bis"), [], unmatched, { googlePlaceId: "g1" }),
  ]);
  expect(rows.map((r) => [r.index, r.duplicateOf])).toEqual([
    [0, undefined],
    [1, undefined],
    [2, 0],
    [3, 0],
  ]);
});

test("an override wins over the scorer's decision", () => {
  expect(
    resolveRow(matchRow(place(0, "A"), [], unmatched, { googlePlaceId: "g" })),
  ).toEqual({
    kind: "matched",
    googlePlaceId: "g",
    byHand: true,
  });
  expect(resolveRow(matchRow(place(0, "A"), [], matched("g")))).toMatchObject({
    byHand: false,
  });
});

test("a validated override carries its details to --apply", () => {
  const snapshot = {
    placeId: "g",
    name: "Palais Garnier",
    address: "Pl. de l'Opéra, 75009 Paris",
    lat: 48.87,
    lng: 2.33,
  };
  expect(
    resolveRow(
      matchRow(place(0, "Opéra Garnier"), [], unmatched, {
        googlePlaceId: "g",
        note: "same building",
        snapshot,
      }),
    ),
  ).toEqual({ kind: "matched", googlePlaceId: "g", byHand: true, snapshot });
});

test("a Google override may carry the user's title", () => {
  expect(
    resolveRow(
      matchRow(place(0, "Japantown"), [], unmatched, {
        googlePlaceId: "g",
        title: "Japantown",
      }),
    ),
  ).toEqual({
    kind: "matched",
    googlePlaceId: "g",
    byHand: true,
    title: "Japantown",
  });
});

test("custom and discard overrides resolve to their own kinds, never a duplicate", () => {
  const custom = matchRow(place(0, "Bunker"), [], unmatched, {
    custom: { name: "Bunker", lat: 52.5, lng: 13.4 },
  });
  const discarded = matchRow(place(1, "Fête"), [], unmatched, {
    discard: true,
    reason: "a one-off party",
  });
  expect(resolveRow(custom)).toEqual({
    kind: "custom",
    name: "Bunker",
    lat: 52.5,
    lng: 13.4,
  });
  expect(resolveRow(discarded)).toEqual({
    kind: "discarded",
    reason: "a one-off party",
  });
  // Two custom places of one name are two places.
  const twin = matchRow(place(2, "Bunker"), [], unmatched, {
    custom: { name: "Bunker", lat: 52.5, lng: 13.4 },
  });
  expect(markDuplicates([custom, twin]).map((r) => r.duplicateOf)).toEqual([
    undefined,
    undefined,
  ]);
});

test("rows are refused for another export or a renamed row", () => {
  const umami = place(0, "Umami");
  const places = [umami, place(1, "Wen Cheng")];
  const file = {
    version: 2 as const,
    inputSha256: "abc",
    rows: [matchRow(umami, [], matched("g1"))],
  };
  expect([...rowsFor(file, places, "abc").keys()]).toEqual([0]);
  expect(() => rowsFor(file, places, "other")).toThrow(
    /different Mapstr export/,
  );
  expect(() => rowsFor(file, [place(0, "Renamed")], "abc")).toThrow(
    /does not match/,
  );
});
