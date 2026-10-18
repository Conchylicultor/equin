import { z } from "zod";
import { idKindField } from "@plugins/ids/core";
import {
  nullable,
  type FieldOptionMeta,
  type FieldsRecord,
} from "@plugins/fields/core";
import {
  enumTextField,
  parsedTextField,
  textField,
} from "@plugins/fields/plugins/text/plugins/config/core";
import { intField } from "@plugins/fields/plugins/int/plugins/config/core";
import { dateField } from "@plugins/fields/plugins/date/plugins/config/core";
import { jsonField } from "@plugins/fields/plugins/json/plugins/config/core";
import { tagsField } from "@plugins/fields/plugins/tags/plugins/config/core";
import { locationField } from "@plugins/fields/plugins/location/core";
import {
  BUSINESS_STATUSES,
  type BusinessStatus,
} from "@plugins/integrations/plugins/google-maps/plugins/places-api/core";
import {
  parseSavedSymbolName,
  SavedSymbolNameSchema,
} from "@plugins/ui/plugins/icons/plugins/saved-names/core";
import { placeIdKind, placeTagIdKind } from "./id-kinds";
import { CHILD_COLOR_MODES, TAG_ROLES } from "./tag-tree";

// Web-safe field records for the Places app's two tables — the single source of
// truth for both the Drizzle pgTable (`defineEntity`, `server/internal/tables.ts`)
// and the wire schema (`fieldsToZodObject`, `./schema.ts`). Keys are in column
// order; DDL (defaults, unique indexes) lives in the `defineEntity` meta.

// `jsonField<string[]>`, not `stringListField`: the string-list type has no
// storage contribution (the `mail_threads.labelIds` idiom). `tags` is the
// exception: a `tagsField` is the same `jsonb` string array, and its type is
// what the places list filters it by (has any / all / none of, nested).
const stringList = () =>
  jsonField<string[]>({ schema: z.array(z.string()), default: [] });

// A nullable icon column: `null` until Haiku (or the user) picks one. The inner
// default is never reached — the column is nullable and carries no DB default.
const savedIcon = () =>
  nullable(
    parsedTextField(SavedSymbolNameSchema, {
      default: parseSavedSymbolName("location-on"),
    }),
  );

/** Google's business status, as the status field's options (null is "None"). */
const BUSINESS_STATUS_META: {
  readonly [S in BusinessStatus]: FieldOptionMeta;
} = {
  OPERATIONAL: { label: "Open", variant: "success" },
  CLOSED_TEMPORARILY: { label: "Temporarily closed", variant: "warning" },
  CLOSED_PERMANENTLY: { label: "Permanently closed", variant: "destructive" },
};

/**
 * One saved place: a Google place snapshot (name, address, location, types)
 * plus what the user made of it — title, tags, note — and the icon Haiku
 * picked. Or a CUSTOM place (a pin with no Google place behind it — a closed
 * venue, a bunker, a one-off event): `googlePlaceId` is null, and so is every
 * Google-only column (`title`, `primaryType`, `mapsUrl`, `businessStatus`,
 * `types` empty) — a DB check holds the pair together (`places_custom_no_google`).
 *
 * The name the app shows is `placeName(place)`: the user's `title` when set,
 * else `name`.
 */
export const placeFields = {
  id: idKindField(placeIdKind),
  /**
   * Google's place id; null for a custom place. Unique where set: a Google
   * place is saved once.
   */
  googlePlaceId: nullable(textField()),
  /**
   * Google's name for a Google place (re-fetched monthly with its details);
   * the user's own name for a custom place, which has no title.
   */
  name: textField(),
  /**
   * The user's own name for a Google place ("Japantown" for the restaurant
   * Google calls "Rue Sainte-Anne"), shown instead of Google's; null shows
   * Google's. Never written by the refresh job. Always null on a custom place,
   * whose `name` is already the user's.
   */
  title: nullable(textField()),
  /** Google's formatted address; for a custom place, whatever it was saved with ("" when none). */
  address: textField({ label: "Address" }),
  location: locationField({ label: "Location" }),
  /** Google's machine type (`cafe`, `park`, …); null when Google gives none. */
  primaryType: nullable(textField()),
  /** Google's full type list, most specific first — what auto-tagging reads. */
  types: stringList(),
  mapsUrl: nullable(textField()),
  /**
   * Whether Google says the place is still in business (`CLOSED_PERMANENTLY`
   * greys its pin); null when Google gives none. Refreshed monthly.
   */
  businessStatus: nullable(
    enumTextField(BUSINESS_STATUSES, {
      label: "Google status",
      options: BUSINESS_STATUS_META,
    }),
  ),
  /**
   * Since when Google no longer finds `googlePlaceId` (a refresh answered
   * NOT_FOUND: the id is obsolete — the place closed, moved, or Google re-keyed
   * it). The saved snapshot stays as it was last fetched; Google hands over no
   * successor id, so nothing re-links it automatically. Null while Google still
   * finds it, and always on a custom place. Cleared by a refresh that succeeds.
   */
  googleLostAt: nullable(dateField()),
  /** One Material Symbols name, picked by Haiku from the place; null until then. */
  icon: savedIcon(),
  note: textField({ label: "Note" }),
  /** Tag ids, in the order they were added (Been / Want to go among them). */
  tags: tagsField({ label: "Tags" }),
  /**
   * The subset of `tags` set automatically from the place's Google types (the
   * card's AUTO badge). Removing a tag removes it here too, so `autoTags ⊆ tags`.
   */
  autoTags: stringList(),
  /** When the Google snapshot was last fetched. */
  fetchedAt: dateField(),
  createdAt: dateField({ label: "Saved" }),
  updatedAt: dateField(),
} satisfies FieldsRecord;

/**
 * One tag of the single nested tag tree. There is no category / label split:
 * Been and Want to go are ordinary tags, found by their `role`.
 */
export const placeTagFields = {
  id: idKindField(placeTagIdKind),
  name: textField({ label: "Name", primary: true }),
  /** The parent tag; null at the root. Never a cycle (the PATCH rejects one). */
  parentId: nullable(textField()),
  /** Hex colour; null inherits the nearest ancestor's (`tagColor`). */
  color: nullable(textField()),
  /**
   * How this tag colours its colourless children: `ramp` = an ordered shade of
   * its colour by rank, light → deep (`tagColor`); null = they inherit it.
   */
  childColors: nullable(enumTextField(CHILD_COLOR_MODES)),
  icon: savedIcon(),
  /** Google place types that auto-set this tag on a newly saved place. */
  googleTypes: tagsField({ label: "Auto-set from Google types" }),
  /** Order among siblings, ascending. */
  rank: intField(),
  /**
   * What the app finds this tag by (`been`, `want`), set by the seed; null for
   * every other tag. Unique where set, and a tag with a role cannot be deleted.
   */
  role: nullable(enumTextField(TAG_ROLES)),
  createdAt: dateField(),
  updatedAt: dateField(),
} satisfies FieldsRecord;
