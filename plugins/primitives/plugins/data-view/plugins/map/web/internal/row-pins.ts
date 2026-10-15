import type { MapPin } from "@plugins/map/core";
import { LocationSchema } from "@plugins/fields/plugins/location/core";
import type { FieldDef } from "@plugins/primitives/plugins/data-view/web";

/** The type id the map view looks for when no `locationField` is configured. */
export const LOCATION_TYPE_ID = "location";

/**
 * The `pinType` of a row pin when the consumer names none: claimed by no
 * plugin, so `GeoMap.Pin` / `GeoMap.Cluster` fall back to the map primitive's
 * default pin and count disc.
 */
export const DEFAULT_ROW_PIN_TYPE = "data-view.row";

export type LocationFieldPick<TRow> =
  | { kind: "found"; field: FieldDef<TRow> }
  | { kind: "missing-configured"; id: string }
  | { kind: "none" };

/**
 * The field the pins are read from: the configured `locationField` id, else
 * the first field whose type chain (`typeChain`, following `extends`) reaches
 * `location`. A configured id that names no field is its own outcome — a typo
 * in a saved view must say so, not silently fall back to another field.
 */
export function pickLocationField<TRow>(
  fields: readonly FieldDef<TRow>[],
  configured: string | undefined,
  typeChain: (typeId: string) => readonly string[],
): LocationFieldPick<TRow> {
  if (configured !== undefined && configured !== "") {
    const field = fields.find((f) => f.id === configured);
    return field
      ? { kind: "found", field }
      : { kind: "missing-configured", id: configured };
  }
  const field = fields.find((f) =>
    typeChain(f.type ?? "text").includes(LOCATION_TYPE_ID),
  );
  return field ? { kind: "found", field } : { kind: "none" };
}

export interface RowPinsInput<TRow> {
  rows: readonly TRow[];
  rowKey: (row: TRow, index: number) => string;
  locationField: FieldDef<TRow>;
  pinType: string;
  pinData?: (row: TRow) => unknown;
  rank?: (row: TRow) => number;
  label: (row: TRow) => string | undefined;
}

export interface RowPins<TRow> {
  pins: MapPin[];
  /** Pin id → its row, for turning a pin click back into a row activation. */
  rowById: ReadonlyMap<string, TRow>;
  /** Rows with no valid location, so not on the map. */
  missing: number;
}

/**
 * One pin per row holding a valid location. The location is the field's
 * structured `data` projection when it declares one, else its `value`; either
 * is validated by `LocationSchema`, and a row that fails is counted in
 * `missing` rather than drawn somewhere wrong.
 */
export function rowsToPins<TRow>(input: RowPinsInput<TRow>): RowPins<TRow> {
  const { rows, rowKey, locationField, pinType, pinData, rank, label } = input;
  const read = locationField.data ?? locationField.value;
  const pins: MapPin[] = [];
  const rowById = new Map<string, TRow>();
  let missing = 0;
  rows.forEach((row, index) => {
    const parsed = LocationSchema.safeParse(read?.(row));
    if (!parsed.success) {
      missing += 1;
      return;
    }
    const id = rowKey(row, index);
    const pin: MapPin = {
      kind: "pin",
      id,
      position: { lat: parsed.data.lat, lng: parsed.data.lng },
      pinType,
    };
    const name = label(row);
    if (name !== undefined && name !== "") pin.label = name;
    if (pinData) pin.data = pinData(row);
    if (rank) pin.rank = rank(row);
    pins.push(pin);
    rowById.set(id, row);
  });
  return { pins, rowById, missing };
}
