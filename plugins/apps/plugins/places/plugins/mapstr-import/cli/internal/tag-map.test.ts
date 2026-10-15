import { expect, test } from "bun:test";
import { mapMapstrTags, unknownMapstrTags } from "./tag-map";

test("maps roles, child paths and plain names onto seed keys, deduped", () => {
  expect(
    mapMapstrTags([
      "Food/Bar",
      ".Done",
      "To Try",
      "To Try",
      "40€",
      "Extérieur",
    ]),
  ).toEqual(["bar", "been", "price-40", "outdoors"]);
  expect(mapMapstrTags([".Todo", "Jeux/Shows/Events", "Museum/Autre"])).toEqual(
    ["want", "shows", "museum-other"],
  );
});

test("a decomposed accent still maps", () => {
  expect(mapMapstrTags(["Extérieur"])).toEqual(["outdoors"]);
});

test("every tag of the real export is known; an unknown one is loud", () => {
  const real = [
    ".Done",
    ".Todo",
    "To Try",
    "Food/Bar",
    "Food/Fast-food",
    "Food/Restaurant",
    "Food/Snacks",
    "Museum/Art",
    "Museum/Autre",
    "Museum/History",
    "Museum/Science",
    "Attraction",
    "Extérieur",
    "Jeux/Shows/Events",
    "Club",
    "Shop",
    "Area",
    "Planifier",
    "40€",
    "100+€",
    "Permanently closed",
    "Track",
    "Home",
    "Social",
  ];
  expect(unknownMapstrTags(real)).toEqual([]);
  expect(unknownMapstrTags(["Food/Bar", "Nope", "Nope"])).toEqual(["Nope"]);
  expect(() => mapMapstrTags(["Nope"])).toThrow(/Unknown Mapstr tag/);
  expect(() => mapMapstrTags(["toString"])).toThrow(/Unknown Mapstr tag/);
});
