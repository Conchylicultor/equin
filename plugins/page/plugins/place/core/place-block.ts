import type { z } from "zod";
import { defineBlock } from "@plugins/page/plugins/editor/core";
import { PlaceDataSchema } from "./schemas";
import { PlaceFamilySchema, PlaceKindSchema } from "./kinds";
import { symbol } from "@plugins/ui/plugins/icons/core";

const locationOnIcon = symbol("location-on");

export const PLACE_TYPE = "place";

/** Parse a numeric attribute, loudly. An attribute that is there but unreadable is a bug, not a default. */
function numberAttr(raw: string | undefined, name: string): number | undefined {
  if (raw === undefined || raw === "") return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new Error(
      `markdown: <place ${name}="${raw}"/> — \`${name}\` must be a number.`,
    );
  }
  return value;
}

/**
 * The `fetched` stamp travels as ISO 8601, not as a raw epoch: this attribute is
 * read by humans and agents in the page's markdown, and "2026-08-18T…" says what
 * "1755518400000" does not.
 */
function timestampAttr(raw: string | undefined): number | undefined {
  if (raw === undefined || raw === "") return undefined;
  const value = Date.parse(raw);
  if (Number.isNaN(value)) {
    throw new Error(
      `markdown: <place fetched="${raw}"/> — \`fetched\` must be an ISO 8601 date.`,
    );
  }
  return value;
}

/**
 * Read the `kind` / `family` attribute. Unlike `lat`/`fetched`, an unknown value
 * is read as ABSENT rather than thrown: both sets are closed and grow, so
 * markdown written by a newer build (or by hand) can name a value this one does
 * not know, and the only consequence is a generic pin or a neutral circle until
 * the next refresh re-maps it.
 */
function closedSetAttr<T extends string>(
  schema: z.ZodType<T>,
  raw: string | undefined,
): T | undefined {
  const parsed = schema.safeParse(raw);
  return parsed.success ? parsed.data : undefined;
}

export const placeBlock = defineBlock({
  type: PLACE_TYPE,
  schema: PlaceDataSchema,
  label: "Place",
  icon: locationOnIcon,
  aliases: ["address", "location", "map", "maps"],
  empty: () => ({}), // no placeId → the search UI
  // The card is a `Row` (its `p-row` padding) inside the block's `Inset y="xs"`,
  // led by a 2.5rem kind circle that sets the row's height. Seat the gutter rail
  // on the circle's centre rather than on the phantom text line the default
  // assumes. Keep 1.25rem in step with the card's `size-10` circle.
  gutterFirstLineCenter: "calc(var(--space-xs) + var(--pad-row-y) + 1.25rem)",
  // `<place …/>` — a self-closing tag rather than the derived JSON-attribute
  // fallback, so an agent reading the page through `read_page` sees the place
  // itself. `body: "none"`: a place has no content of its own, so a body on
  // parse is a loud rejection rather than a silent drop.
  //
  // The tag carries the IDENTITY (`provider` + `place-id`) alongside the display
  // fields on purpose: without it a copy/paste would land as an empty search box
  // instead of the same place, and the refresh would have nothing to re-ask.
  markdown: {
    tag: {
      name: "place",
      body: "none",
      attrs: (data) => ({
        name: data.name,
        address: data.address,
        category: data.category,
        kind: data.kind,
        family: data.family,
        maps: data.mapsUrl,
        lat: data.lat,
        lng: data.lng,
        provider: data.providerId,
        "place-id": data.placeId,
        fetched:
          data.fetchedAt === undefined
            ? undefined
            : new Date(data.fetchedAt).toISOString(),
      }),
      parseAttrs: (attrs) => ({
        providerId: attrs.provider,
        placeId: attrs["place-id"],
        name: attrs.name,
        address: attrs.address,
        category: attrs.category,
        kind: closedSetAttr(PlaceKindSchema, attrs.kind),
        family: closedSetAttr(PlaceFamilySchema, attrs.family),
        mapsUrl: attrs.maps,
        lat: numberAttr(attrs.lat, "lat"),
        lng: numberAttr(attrs.lng, "lng"),
        fetchedAt: timestampAttr(attrs.fetched),
      }),
    },
  },
});
