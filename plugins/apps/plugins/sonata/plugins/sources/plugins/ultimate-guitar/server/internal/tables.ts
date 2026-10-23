import { _songs } from "@plugins/apps/plugins/sonata/plugins/library/server";
import { defineExtension } from "@plugins/infra/plugins/entity-extensions/server";
import { ultimateGuitarShape } from "../../core";

// This source's persisted data for a song (`core/shape.ts` declares the shape
// and the field it exposes to every list of songs). Table:
// `sonata_songs_ext_ultimate_guitar`.
export const songUltimateGuitar = defineExtension(
  _songs,
  "ultimate_guitar",
  ultimateGuitarShape,
);
export const _songUltimateGuitarExt = songUltimateGuitar.table; // drizzle-kit discovery
