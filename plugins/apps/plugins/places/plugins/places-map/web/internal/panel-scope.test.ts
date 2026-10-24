import { describe, expect, test } from "bun:test";
import type { LatLng } from "@plugins/map/core";
import { scopePlaces } from "./panel-scope";

interface Spot {
  id: string;
  at: LatLng;
}

const spot = (id: string, lat: number, lng: number): Spot => ({
  id,
  at: { lat, lng },
});

const PARIS = { south: 48.8, west: 2.25, north: 48.9, east: 2.45 };
const rows = [
  spot("louvre", 48.861, 2.336),
  spot("lyon", 45.76, 4.84),
  spot("orsay", 48.86, 2.326),
];
const at = (s: Spot) => s.at;

describe("scopePlaces", () => {
  test("in view keeps the rows the map shows, in their order", () => {
    const out = scopePlaces(rows, PARIS, "in-view", at);
    expect(out.shown.map((s) => s.id)).toEqual(["louvre", "orsay"]);
    expect(out.inView).toBe(2);
    expect(out.outside).toBe(1);
  });

  test("all keeps every row, with the same counts", () => {
    const out = scopePlaces(rows, PARIS, "all", at);
    expect(out.shown).toBe(rows);
    expect(out.inView).toBe(2);
    expect(out.outside).toBe(1);
  });

  test("nothing in view: an empty list, every row outside", () => {
    const out = scopePlaces(
      rows,
      { south: 0, west: 0, north: 1, east: 1 },
      "in-view",
      at,
    );
    expect(out.shown).toEqual([]);
    expect(out.inView).toBe(0);
    expect(out.outside).toBe(3);
  });

  test("a view across the antimeridian", () => {
    const fiji = spot("fiji", -17.7, 178.1);
    const samoa = spot("samoa", -13.8, -172.1);
    const out = scopePlaces(
      [fiji, samoa, ...rows],
      { south: -20, west: 170, north: -10, east: -170 },
      "in-view",
      at,
    );
    expect(out.shown.map((s) => s.id)).toEqual(["fiji", "samoa"]);
  });

  test("edges count as in view", () => {
    const out = scopePlaces(
      [spot("corner", PARIS.south, PARIS.west)],
      PARIS,
      "in-view",
      at,
    );
    expect(out.inView).toBe(1);
  });
});
