import {
  defineEntity,
  defaultNow,
} from "@plugins/infra/plugins/entities/server";
import { songFields } from "../../core/schemas";

// Physical table — **source-agnostic** generic metadata only. Per-source raw
// (MIDI attachment, chord-grid JSON, …) lives in each source plugin's own
// `sonata_songs_ext_<source>` entity-extension table (FK CASCADE on delete), so
// adding a source never touches this schema. Kept free of the server-only
// `Attachments` import: the generic song↔attachment link lives in its
// `schema-attachments.ts` sibling.
//
// The table + the `Song` wire schema both derive from the single `songFields`
// record (core), so a column/schema drift is unrepresentable. `source` carries
// no DB default: `createSongRow` is the sole insert path and always supplies a
// source, so the NOT NULL constraint is the real guarantee (a source-less insert
// must fail loudly rather than silently default).
const songs = defineEntity("sonata_songs", songFields, {
  primaryKey: "id",
  columns: {
    // Score-level (composed-timeline) length columns carry no DB default.
    createdAt: { default: defaultNow() },
    sourcesChangedAt: { default: defaultNow() },
  },
});

// drizzle-kit schema-glob discovery. Name kept so the extension side-tables that
// FK-reference `_songs.id` and the server barrel re-export don't churn.
export const _songs = songs.table;
