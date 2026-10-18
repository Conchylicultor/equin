import {
  defineEntity,
  defaultNow,
} from "@plugins/infra/plugins/entities/server";
import { _songs } from "@plugins/apps/plugins/sonata/plugins/library/server";
import { trackViewEntityRef, trackViewServerFields } from "../../core/schemas";

/**
 * Per-(song, track) view override. 1:many over a song (one row per track), so
 * this is a plain table with a compound PK — NOT an entity-extension (those are
 * strictly 1:1 on the parent id). The FK cascades on song delete so overrides
 * are reclaimed with their song. `trackId` is the Score's `TrackMeta.id` (e.g.
 * `t0`, or `L0:t0` for a merged multi-source score). The table + wire schema
 * both derive from the single `trackViewEntityRef` (core); the timestamps
 * stay in the DDL but are kept off the wire.
 */
export const trackView = defineEntity(
  trackViewEntityRef,
  trackViewServerFields,
  {
    primaryKey: ["songId", "trackId"],
    // Which columns move `updatedAt` (derived by a DB trigger; a write to it
    // raises): every user-set override counts, the identity pair does not.
    updatedAt: {
      touchedBy: {
        songId: false,
        trackId: false,
        color: true,
        instrument: true,
        muted: true,
        hidden: true,
        volume: true,
        createdAt: false,
      },
    },
    columns: {
      songId: {
        references: {
          column: () => _songs.id,
          onDelete: "cascade",
          // A rewrite of the song ids (bare uuid → `song-<uuid>`, `plugins/ids`)
          // carries the per-track overrides along.
          onUpdate: "cascade",
        },
      },
      muted: { default: false },
      hidden: { default: false },
      // Unity gain, so a track with no persisted row sounds exactly as recorded.
      volume: { default: 1 },
      createdAt: { default: defaultNow() },
      updatedAt: { default: defaultNow() },
    },
  },
);

// drizzle-kit schema-glob discovery. Name kept so the barrel re-export and the
// routes referencing the table don't churn.
export const _trackView = trackView.table;
