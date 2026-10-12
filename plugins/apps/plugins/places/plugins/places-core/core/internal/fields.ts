import { z } from "zod";
import { idKindField } from "@plugins/ids/core";
import { nullable, type FieldsRecord } from "@plugins/fields/core";
import {
  enumTextField,
  parsedTextField,
  textField,
} from "@plugins/fields/plugins/text/plugins/config/core";
import { intField } from "@plugins/fields/plugins/int/plugins/config/core";
import { dateField } from "@plugins/fields/plugins/date/plugins/config/core";
import { jsonField } from "@plugins/fields/plugins/json/plugins/config/core";
import { locationField } from "@plugins/fields/plugins/location/core";
import {
  parseSavedSymbolName,
  SavedSymbolNameSchema,
} from "@plugins/ui/plugins/icons/plugins/saved-names/core";
import { placeIdKind, placeTagIdKind } from "./id-kinds";
import { TAG_ROLES } from "./tag-tree";

// Web-safe field records for the Places app's two tables — the single source of
// truth for both the Drizzle pgTable (`defineEntity`, `server/internal/tables.ts`)
// and the wire schema (`fieldsToZodObject`, `./schema.ts`). Keys are in column
// order; DDL (defaults, unique indexes) lives in the `defineEntity` meta.

// `jsonField<string[]>`, not `stringListField`: the string-list type has no
// storage contribution (the `mail_threads.labelIds` / `events.tags` idiom).
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

/**
 * One saved place: a Google place snapshot (name, address, location, types)
 * plus what the user made of it — tags, note — and the icon Haiku picked.
 */
export const placeFields = {
  id: idKindField(placeIdKind),
  /** Google's place id. Unique: a place is saved once. */
  googlePlaceId: textField(),
  name: textField(),
  address: textField(),
  location: locationField(),
  /** Google's machine type (`cafe`, `park`, …); null when Google gives none. */
  primaryType: nullable(textField()),
  /** Google's full type list, most specific first — what auto-tagging reads. */
  types: stringList(),
  mapsUrl: nullable(textField()),
  /** One Material Symbols name, picked by Haiku from the place; null until then. */
  icon: savedIcon(),
  note: textField(),
  /** Tag ids, in the order they were added. Always holds the todo or done tag. */
  tags: stringList(),
  /**
   * The subset of `tags` set automatically from the place's Google types (the
   * card's AUTO badge). Removing a tag removes it here too, so `autoTags ⊆ tags`.
   */
  autoTags: stringList(),
  /** When the Google snapshot was last fetched. */
  fetchedAt: dateField(),
  createdAt: dateField(),
  updatedAt: dateField(),
} satisfies FieldsRecord;

/**
 * One tag of the single nested tag tree. There is no category / label split:
 * Status › Todo / Done are ordinary tags, found by their `role`.
 */
export const placeTagFields = {
  id: idKindField(placeTagIdKind),
  name: textField(),
  /** The parent tag; null at the root. Never a cycle (the PATCH rejects one). */
  parentId: nullable(textField()),
  /** Hex colour; null inherits the nearest ancestor's (`tagColor`). */
  color: nullable(textField()),
  icon: savedIcon(),
  /** Google place types that auto-set this tag on a newly saved place. */
  googleTypes: stringList(),
  /** Order among siblings, ascending. */
  rank: intField(),
  /**
   * What the status logic finds this tag by (`status`, `todo`, `done`), set by
   * the seed; null for every other tag. Unique where set, and a tag with a role
   * cannot be deleted.
   */
  role: nullable(enumTextField(TAG_ROLES)),
  createdAt: dateField(),
  updatedAt: dateField(),
} satisfies FieldsRecord;
