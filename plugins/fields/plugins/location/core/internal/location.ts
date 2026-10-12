import { z } from "zod";
import {
  defineFieldType,
  defineFieldIdentity,
  pickMeta,
  type FieldDef,
  type FieldMeta,
} from "@plugins/fields/core";
import { symbol } from "@plugins/ui/plugins/icons/core";

export const LocationSchema = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  address: z.string().optional(),
});

export type Location = z.infer<typeof LocationSchema>;

export const locationFieldType = defineFieldType<Location>("location");

/** The text a location presents as: its address, else `lat, lng` to 4 decimals. */
export function locationLabel(location: Location): string {
  if (location.address !== undefined && location.address !== "") {
    return location.address;
  }
  return `${location.lat.toFixed(4)}, ${location.lng.toFixed(4)}`;
}

export const locationIdentity = defineFieldIdentity<Location>({
  type: locationFieldType,
  label: "Location",
  icon: symbol("location-on"),
  coerce: locationLabel,
});

export interface LocationFieldDef extends FieldDef<Location> {
  readonly type: typeof locationFieldType;
}

/**
 * A geographic point with an optional address. Wrap in `nullable(...)` for a
 * column that may hold no location yet; the default here is the 0,0 point.
 */
export function locationField(
  opts?: FieldMeta & { default?: Location },
): LocationFieldDef {
  return Object.freeze({
    type: locationFieldType,
    schema: LocationSchema,
    defaultValue: opts?.default ?? { lat: 0, lng: 0 },
    meta: pickMeta(opts),
  });
}
