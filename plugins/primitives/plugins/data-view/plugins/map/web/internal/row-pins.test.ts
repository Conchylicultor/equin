import { describe, expect, it } from "bun:test";
import type { FieldDef } from "@plugins/primitives/plugins/data-view/web";
import { pickLocationField, rowsToPins, withKeptRows } from "./row-pins";

interface Place {
  id: string;
  name: string;
  where: unknown;
}

const nameField: FieldDef<Place> = {
  id: "name",
  label: "Name",
  value: (p) => p.name,
};
const whereField: FieldDef<Place> = {
  id: "where",
  label: "Where",
  type: "location",
  data: (p) => p.where,
};

const places: Place[] = [
  { id: "a", name: "Louvre", where: { lat: 48.86, lng: 2.34 } },
  { id: "b", name: "Nowhere", where: null },
  { id: "c", name: "Off the globe", where: { lat: 120, lng: 0 } },
  { id: "d", name: "", where: { lat: 1, lng: 2, address: "X" } },
];

const base = {
  rows: places,
  rowKey: (p: Place) => p.id,
  locationField: whereField,
  pinType: "place",
  label: (p: Place) => p.name,
};

describe("rowsToPins", () => {
  it("pins every row with a valid location and counts the rest", () => {
    const { pins, rowById, missing } = rowsToPins(base);
    expect(pins).toEqual([
      {
        kind: "pin",
        id: "a",
        position: { lat: 48.86, lng: 2.34 },
        pinType: "place",
        label: "Louvre",
      },
      { kind: "pin", id: "d", position: { lat: 1, lng: 2 }, pinType: "place" },
    ]);
    expect(missing).toBe(2);
    expect(rowById.get("a")).toBe(places[0]);
    expect(rowById.has("b")).toBe(false);
  });

  it("carries pinData as the pin's payload", () => {
    const { pins } = rowsToPins({ ...base, pinData: (p) => ({ ref: p.id }) });
    expect(pins.map((p) => p.data)).toEqual([{ ref: "a" }, { ref: "d" }]);
  });

  it("reads the field's value when it declares no data projection", () => {
    const valueField = {
      id: "where",
      label: "Where",
      type: "location",
      value: (p: Place) => p.where,
    } as FieldDef<Place>;
    const { pins } = rowsToPins({ ...base, locationField: valueField });
    expect(pins.map((p) => p.id)).toEqual(["a", "d"]);
  });
});

describe("pickLocationField", () => {
  const chain = (t: string) => (t === "place-loc" ? [t, "location"] : [t]);

  it("defaults to the first field whose type chain reaches location", () => {
    const derived: FieldDef<Place> = { ...whereField, type: "place-loc" };
    expect(pickLocationField([nameField, derived], undefined, chain)).toEqual({
      kind: "found",
      field: derived,
    });
  });

  it("honours a configured field id", () => {
    expect(pickLocationField([nameField, whereField], "name", chain)).toEqual({
      kind: "found",
      field: nameField,
    });
  });

  it("says when the configured field is missing, or none exists", () => {
    expect(pickLocationField([whereField], "gone", chain)).toEqual({
      kind: "missing-configured",
      id: "gone",
    });
    expect(pickLocationField([nameField], undefined, chain)).toEqual({
      kind: "none",
    });
  });
});

describe("withKeptRows", () => {
  const key = (p: Place) => p.id;
  const [a, b, c] = places as [Place, Place, Place];

  it("returns the view's rows untouched when nothing is kept", () => {
    const shown = [a];
    expect(withKeptRows(shown, places, key, new Set())).toBe(shown);
  });

  it("adds a kept row the view hid, after the view's rows", () => {
    expect(withKeptRows([b], places, key, new Set(["c", "a"]))).toEqual([
      b,
      a,
      c,
    ]);
  });

  it("never draws a kept row twice", () => {
    const shown = [a, b];
    expect(withKeptRows(shown, places, key, new Set(["a"]))).toBe(shown);
  });

  it("ignores a kept key that names no row", () => {
    expect(withKeptRows([a], places, key, new Set(["zz"]))).toEqual([a]);
  });
});
