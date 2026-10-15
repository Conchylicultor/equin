import { expect, test } from "bun:test";
import type { PlaceSnapshot } from "@plugins/integrations/plugins/google-maps/plugins/places-api/core";
import type { MapstrPlace } from "./export";
import { mergeImports } from "./merge";
import { mapMapstrTags } from "./tag-map";

const place = (
  index: number,
  name: string,
  over: Partial<MapstrPlace> = {},
): MapstrPlace => ({
  index,
  name,
  address: "Berlin",
  lat: 52.5,
  lng: 13.4,
  date: "2026-01-01T00:00:00.000Z",
  note: "",
  tags: [".Done"],
  ...over,
});

const snapshot = (placeId: string, name: string): PlaceSnapshot => ({
  placeId,
  name,
  address: "Berlin",
  lat: 52.5,
  lng: 13.4,
});

const google = (placeId: string, name: string, title?: string) => ({
  kind: "google" as const,
  snapshot: snapshot(placeId, name),
  ...(title === undefined ? {} : { title }),
});

test("rows sharing a Google place merge into one: tags united, notes kept, earliest date", () => {
  const imported = mergeImports([
    {
      place: place(5, "Zucker Museum", {
        tags: [".Todo"],
        note: "Musée du sucre",
        date: "2020-01-01T00:00:00.000Z",
      }),
      source: google("g1", "German Museum of Technology"),
    },
    {
      place: place(4, "German Museum of Technology", { note: "Super" }),
      source: google("g1", "German Museum of Technology"),
    },
    { place: place(6, "Other"), source: google("g2", "Other") },
  ]);
  expect(imported).toHaveLength(2);
  const [merged] = imported;
  expect(
    merged?.place.kind === "google" ? merged.place.snapshot.placeId : null,
  ).toBe("g1");
  expect(new Set(merged?.tags)).toEqual(
    new Set([...mapMapstrTags([".Done"]), ...mapMapstrTags([".Todo"])]),
  );
  expect(merged?.note).toBe(
    "Super\n\nAlso saved in Mapstr as “Zucker Museum”.\n\nMusée du sucre",
  );
  expect(merged?.createdAt).toEqual(new Date("2020-01-01T00:00:00.000Z"));
});

test("a place Google names differently keeps its Mapstr name in the note", () => {
  const [renamed, same] = mergeImports([
    {
      place: place(0, "The Rice Burger", { note: "Bon" }),
      source: google("g1", "Chez Marie"),
    },
    {
      place: place(1, "Musée Bourdelle"),
      source: google("g2", "Bourdelle Museum"),
    },
  ]);
  expect(renamed?.note).toBe("Saved in Mapstr as “The Rice Burger”.\n\nBon");
  expect(same?.note).toBe("");
});

test("a titled place keeps no Mapstr-name line: the title says it", () => {
  const [titled] = mergeImports([
    {
      place: place(0, "Japantown", { note: "Ramen" }),
      source: google("g1", "Rue Sainte-Anne", "Japantown"),
    },
  ]);
  expect(titled?.place).toMatchObject({ kind: "google", title: "Japantown" });
  expect(titled?.note).toBe("Ramen");
});

test("a merged row's title fills in an untitled first row", () => {
  const imported = mergeImports([
    {
      place: place(0, "Rue Sainte-Anne"),
      source: google("g1", "Rue Sainte-Anne"),
    },
    {
      place: place(1, "Japantown"),
      source: google("g1", "Rue Sainte-Anne", "Japantown"),
    },
  ]);
  expect(imported).toHaveLength(1);
  expect(imported[0]?.place).toMatchObject({ title: "Japantown" });
  expect(imported[0]?.note).toBe("");
});

test("custom places never merge, keep their name, pin and Mapstr address, and get no name line", () => {
  const imported = mergeImports([
    {
      place: place(0, "Bunker", { note: "Visite guidée", address: "Wedding" }),
      source: { kind: "custom", name: "Bunker", lat: 52.55, lng: 13.38 },
    },
    {
      place: place(1, "Bunker"),
      source: { kind: "custom", name: "Bunker", lat: 52.5, lng: 13.4 },
    },
  ]);
  expect(imported).toHaveLength(2);
  expect(imported[0]?.place).toEqual({
    kind: "custom",
    name: "Bunker",
    address: "Wedding",
    lat: 52.55,
    lng: 13.38,
  });
  expect(imported[0]?.note).toBe("Visite guidée");
});
