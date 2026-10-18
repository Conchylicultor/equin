/**
 * The Places lists' fields, derived from the `places` and `place_tags`
 * entities: the ids the DataViews (and their saved views) name are unchanged,
 * and Google's status presents as its chips.
 *
 * Run: `./singularity test plugins/apps/plugins/places/plugins/places-core/core`.
 */

import { expect, test } from "bun:test";
import { placeTags, places } from "./resources";

test("the places list derives its stored field ids from the place entity", () => {
  expect(Object.keys(places.fields)).toEqual([
    "address",
    "tags",
    "businessStatus",
    "location",
    "note",
    "createdAt",
  ]);
  expect(places.fields.createdAt).toMatchObject({ label: "Saved" });
  expect(places.fields.tags).toMatchObject({ label: "Tags", typeId: "tags" });
  expect(places.fields.businessStatus.options).toMatchObject({
    CLOSED_PERMANENTLY: { label: "Permanently closed", variant: "destructive" },
  });
});

test("the tag manager derives the tag and its Google types from the tag entity", () => {
  expect(Object.keys(placeTags.fields)).toEqual(["name", "googleTypes"]);
  expect(placeTags.fields.name).toMatchObject({ primary: true });
  expect(placeTags.fields.googleTypes).toMatchObject({ typeId: "tags" });
});
