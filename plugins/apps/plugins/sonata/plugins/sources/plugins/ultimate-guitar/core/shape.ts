import { nullable } from "@plugins/fields/core";
import { intField } from "@plugins/fields/plugins/int/plugins/config/core";
import { textField } from "@plugins/fields/plugins/text/plugins/config/core";
import { defineExtensionShape } from "@plugins/infra/plugins/entity-extensions/core";
import { songsEntityRef } from "@plugins/apps/plugins/sonata/plugins/library/core";

/**
 * This source's persisted data for a song — the full normalized UgTab, attached
 * to the library's `sonata_songs` row via the entity-extensions primitive (1:1
 * side-table `sonata_songs_ext_ultimate_guitar`, FK CASCADE on song delete),
 * which `server/internal/tables.ts` builds from this shape. The persisted
 * columns ARE the UgTab fields, so `hydrate` reconstructs the exact `raw` that
 * `compile()` consumes and the library schema stays source-agnostic.
 *
 * We deliberately store the parsed source-of-truth (`content` markup +
 * metadata), NOT a cached parse: `parseUgTab` is pure and cheap, so a
 * parsed-cache column would only add a staleness footgun.
 *
 * One field is EXPOSED to every list of songs (the library), sorted and
 * filtered server-side: `key` — the tab's key, null for a song with no UG row
 * or a tab UG gives no key. The alignment child reads it for the UG cover's
 * badge — which is why the shape lives in this leaf rather than the UG core:
 * UG web imports the alignment core, so the alignment web reading the UG core
 * would be a cycle.
 */
export const ultimateGuitarShape = defineExtensionShape({
  key: "songId",
  fields: {
    tabId: textField(),
    songName: textField(),
    artistName: textField(),
    type: textField(),
    key: nullable(textField()), // nullable — UG may carry no key
    capo: intField(),
    tuning: textField(),
    content: textField(),
    urlWeb: textField(),
  },
  exposes: {
    parent: songsEntityRef,
    name: "ultimate_guitar",
    fields: { key: { label: "Key" } },
  },
});
