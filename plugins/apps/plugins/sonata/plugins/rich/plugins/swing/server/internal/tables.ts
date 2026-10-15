import { _songs } from "@plugins/apps/plugins/sonata/plugins/library/server";
import { defineExtension } from "@plugins/infra/plugins/entity-extensions/server";
import { swingShape } from "../../shared/resources";

// Per-song swing override attached to the library's `sonata_songs` row via the
// entity-extensions primitive (1:1 side-table, FK CASCADE on song delete). An
// absent row is the song's own feel. Table: `sonata_songs_ext_swing`.
export const songSwing = defineExtension(_songs, "swing", swingShape, {
  columns: {
    swung: { default: false },
    unit: { default: 8 },
    ratio: { default: 2 },
  },
});
export const _songSwingExt = songSwing.table; // drizzle-kit discovery
