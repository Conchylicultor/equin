import { describe, expect, test } from "bun:test";
import type { Block } from "@plugins/page/plugins/editor/core";
import { Rank } from "@plugins/primitives/plugins/rank/core";
import { locatedPlaces } from "./located-places";
import { PLACE_TYPE } from "./place-block";
import type { PlaceData } from "./schemas";

function block(id: string, type: string, data: unknown): Block {
  const at = new Date("2026-01-01T00:00:00.000Z");
  return {
    id,
    pageId: "page-1",
    parentId: "page-1",
    type,
    data,
    rank: Rank.from("a0"),
    expanded: true,
    createdAt: at,
    updatedAt: at,
  };
}

function place(id: string, data: PlaceData): Block {
  return block(id, PLACE_TYPE, data);
}

describe("locatedPlaces", () => {
  test("a picked place with coordinates is located, every field carried", () => {
    const { located, unplaced } = locatedPlaces([
      place("b1", {
        providerId: "google",
        placeId: "p1",
        name: "Café Kitsuné",
        address: "51 Galerie de Montpensier, Paris",
        category: "Coffee shop",
        kind: "cafe",
        family: "food",
        lat: 48.86,
        lng: 2.34,
      }),
    ]);
    expect(unplaced).toBe(0);
    expect(located).toEqual([
      {
        blockId: "b1",
        providerId: "google",
        placeId: "p1",
        name: "Café Kitsuné",
        address: "51 Galerie de Montpensier, Paris",
        category: "Coffee shop",
        kind: "cafe",
        family: "food",
        position: { lat: 48.86, lng: 2.34 },
      },
    ]);
  });

  test("absent optional fields stay absent", () => {
    const { located } = locatedPlaces([
      place("b1", { placeId: "p1", lat: 1, lng: 2 }),
    ]);
    expect(located).toEqual([
      {
        blockId: "b1",
        providerId: undefined,
        placeId: "p1",
        name: undefined,
        address: undefined,
        category: undefined,
        kind: undefined,
        family: undefined,
        position: { lat: 1, lng: 2 },
      },
    ]);
  });

  test("a picked place without coordinates counts as unplaced", () => {
    const { located, unplaced } = locatedPlaces([
      place("b1", { providerId: "google", placeId: "p1" }),
      place("b2", { providerId: "google", placeId: "p2", lat: 1 }),
    ]);
    expect(located).toEqual([]);
    expect(unplaced).toBe(2);
  });

  test("an empty place block, another block type and unparseable data count as nothing", () => {
    const { located, unplaced } = locatedPlaces([
      place("b1", {}),
      block("b2", "text", { lat: 1, lng: 2, placeId: "p" }),
      block("b3", PLACE_TYPE, { lat: "north" }),
    ]);
    expect(located).toEqual([]);
    expect(unplaced).toBe(0);
  });

  test("keeps block order", () => {
    const { located } = locatedPlaces([
      place("b2", { placeId: "p2", lat: 2, lng: 2 }),
      place("b1", { placeId: "p1", lat: 1, lng: 1 }),
    ]);
    expect(located.map((p) => p.blockId)).toEqual(["b2", "b1"]);
  });
});
