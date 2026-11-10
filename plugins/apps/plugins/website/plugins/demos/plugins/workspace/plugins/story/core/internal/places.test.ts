import { expect, test } from "bun:test";
import { isSavedSymbolName } from "@plugins/ui/plugins/icons/plugins/saved-names/core";
import { DEMO_PLACES } from "./places";

const { places, tags } = DEMO_PLACES;

test("every place id and Google id is unique, and carries demo", () => {
  expect(new Set(places.map((p) => p.id)).size).toBe(places.length);
  const google = places.flatMap((p) =>
    p.place.kind === "google" ? [p.place.googlePlaceId] : [],
  );
  expect(new Set(google).size).toBe(google.length);
  expect(places.every((p) => p.id.includes("demo"))).toBe(true);
});

test("every icon, the places' and the tags', is an installed Material Symbols name", () => {
  const icons = [
    ...places.map((p) => p.icon),
    ...tags.flatMap((t) => (t.icon === undefined ? [] : [t.icon])),
  ];
  expect(icons.filter((i) => !isSavedSymbolName(i))).toEqual([]);
});

test("a real user's map: hundreds of places, most of them in Paris", () => {
  const inParis = places.filter(
    ({ place }) =>
      place.lat > 48.7 && place.lat < 49 && place.lng > 2.1 && place.lng < 2.5,
  );
  expect(places.length).toBeGreaterThanOrEqual(250);
  expect(inParis.length / places.length).toBeGreaterThan(0.75);
});

test("no place is both been to and still to go", () => {
  for (const p of places) {
    const roots = p.tags.map((t) => t.join("/"));
    expect(roots.includes("Want to go") && roots.includes("Been")).toBe(false);
  }
});
