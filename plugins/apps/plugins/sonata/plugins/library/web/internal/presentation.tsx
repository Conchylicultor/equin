import { useMemo } from "react";
import {
  FieldPresentation,
  type LiveFieldOptionsRead,
} from "@plugins/network/plugins/live/web";
import { SonataDocument } from "@plugins/apps/plugins/sonata/plugins/document/web";
import { songsEntityRef } from "../../core";

/**
 * The `source` field's options: the player-side source registry, which
 * carries each source's human label (the `Library.Source` registry is
 * id-only). Its ids match the opaque `source` stamped on each song, so the
 * library never hard-codes a source name. A contribution registry is read
 * synchronously, so the set is always known — the options themselves.
 */
export function useSongSourceOptions(): LiveFieldOptionsRead {
  const sources = SonataDocument.Source.useContributions();
  return useMemo(
    () => sources.map((s) => ({ value: s.id, label: s.label })),
    [sources],
  );
}

/**
 * How the songs entity's fields present in every list of songs (the
 * library): registered once against the entity, so no list builds them.
 */
export const songPresentation = FieldPresentation.Register({
  owner: songsEntityRef,
  fields: {
    title: { width: "minmax(0,2fr)" },
    composer: { width: "minmax(0,1fr)" },
    // The opaque per-song source id, as a muted chip labelled by the source
    // registry. Read-only: a song's source is immutable.
    source: { useOptions: useSongSourceOptions, width: "8rem" },
  },
});
