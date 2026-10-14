import { nullable } from "@plugins/fields/core";
import { boolField } from "@plugins/fields/plugins/bool/plugins/config/core";
import { intField } from "@plugins/fields/plugins/int/plugins/config/core";
import { textField } from "@plugins/fields/plugins/text/plugins/config/core";
import { defineExtensionShape } from "@plugins/infra/plugins/entity-extensions/core";
import { songsEntityRef } from "@plugins/apps/plugins/sonata/plugins/library/core";

/**
 * One song's persisted MIDI data, stored in the `sonata_songs_ext_midi`
 * entity-extension table owned by this source plugin (1:1 with `sonata_songs`,
 * FK CASCADE on song delete), which `server/internal/tables.ts` builds from this
 * shape.
 *
 * Two of its fields are EXPOSED to every list of songs (the library), sorted
 * and filtered server-side:
 *
 * - `trackCount` — no default, so a song with no MIDI (no extension row) reads
 *   null;
 * - `sourceMissing` — declares its default (`false`, the column's too), which
 *   a song with no MIDI row reads — so it sorts too (missing files together).
 *   Its "File missing" badge is the `folders` sub-plugin's presentation.
 */
export const songMidiShape = defineExtensionShape({
  key: "songId",
  fields: {
    // Points at the stored `.mid` bytes.
    attachmentId: textField(),
    // The file-derived note-bearing track count shown on the card.
    trackCount: intField({ label: "Tracks" }),
    // Absolute path of the watched-folder file this song was imported from.
    // Null = manual import (never touched by the folder watcher); set = folder-
    // imported and the idempotency key for re-import. See the folders sub-plugin.
    sourcePath: nullable(textField()),
    // True when a folder-imported file has disappeared from disk: the song stays
    // (and stays playable from its copied attachment) but is badged "source
    // deleted". Always false for manual imports.
    sourceMissing: boolField({ default: false }),
    // SHA-256 hex of the raw `.mid` bytes — the content-dedup key. The same file
    // moved to another folder, re-scanned, or re-uploaded collapses into the one
    // song carrying this hash. Null = imported before content-hash dedup existed
    // (backfilled at boot) or its backing attachment file is gone.
    contentHash: nullable(textField()),
  },
  // The dedup key is the server's business (`server/internal/import.ts`); the
  // browser never reads it.
  serverOnly: ["contentHash"],
  exposes: {
    parent: songsEntityRef,
    name: "midi",
    fields: {
      trackCount: {},
      // "File", not "Source": the library already lists a `source` field
      // (which input source a song came from), and two columns both headed
      // "Source" is unreadable in the table. This one is about the backing
      // `.mid` file on disk.
      sourceMissing: { label: "File" },
    },
  },
});
