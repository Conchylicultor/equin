import type { ComponentType } from "react";
import { defineSlot } from "@plugins/framework/plugins/web-sdk/core";
import {
  defineItemActions,
  type CreateOption,
} from "@plugins/primitives/plugins/data-view/web";
import type { Song } from "../core";

/**
 * Extension seams the song library exposes:
 *
 *  - `Source` — the source registry. Each input source (MIDI, chord-grid, …)
 *    contributes how it persists/hydrates a song, so the library stays fully
 *    source-agnostic (the collection–consumer separation). `hydrate(songId)`
 *    returns that source's client raw for the song (or `undefined` if it has
 *    none); `useSongLink` collects every source's raw and loads them in one shot.
 *    The optional `createOption` is a data-view {@link CreateOption} — an "add a
 *    song of this source" affordance the library maps into the gallery's
 *    `creators` (a toolbar "+" menu, since there are N sources). Its `onSelect`
 *    runs fully imperatively (no React hooks): create the song, then
 *    `openSongImperative`. Adding a new source = a new contribution here, with
 *    zero library or core-schema changes.
 *  - `SongActions` — the ONE per-row action set for the library, rendered by
 *    BOTH views: the gallery card and the table row. An action declares where it
 *    belongs with `zone` — `"persistent"` (painted at rest: the card's footer,
 *    the table's reserved trailing track) or the default `"revealed"` (the
 *    hover cluster). There is no per-view action list, so an action added here
 *    can never reach one view and miss the other.
 *
 * Extra library fields are not a seam here: a plugin EXPOSES them from its
 * extension of the songs entity (`defineExtensionShape({ exposes })`, e.g.
 * playback-history's play count), and every list of songs derives them —
 * sortable, filterable, and a table column for free, so a prerecorded "Most
 * played" ordering is just a named `SortRule[]` over `playCount` (a config
 * sort preset).
 */
/**
 * What a source knows about a song at open time. `pending` means the source HAS
 * content for the song but it is not ready yet (e.g. a transcription still
 * running): the player pane renders `Body` (under `label`) instead of composing
 * a score, so an unfinished song is never shown as an empty one.
 */
export type SourceHydration =
  | { kind: "raw"; raw: unknown }
  | { kind: "absent" }
  | {
      kind: "pending";
      label: string;
      Body: ComponentType<{ songId: string }>;
    };

export const Library = {
  Source: defineSlot<{
    /** Stable id of the source (matches its `SonataDocument.Source` id / `rawById` key). */
    sourceId: string;
    /** This source's client raw for `songId`, absent, or pending (see {@link SourceHydration}). */
    hydrate: (songId: string) => Promise<SourceHydration>;
    /**
     * Optional create affordance for this source, mapped by the library into the
     * data-view `creators` (toolbar "+" menu). Plain data — `onSelect` runs
     * imperatively (create + `openSongImperative`), no React hooks.
     */
    createOption?: CreateOption;
  }>({ docLabel: (c) => c.sourceId }),
  /**
   * Per-row actions for the library (Play/Pause, Delete). Minted here,
   * contributed in `web/index.ts`, and passed to the one `DataView` as
   * `itemActions`, so the gallery card and the table row show the same set —
   * Play painted at rest (`zone: "persistent"`), Delete on hover.
   */
  SongActions: defineItemActions<Song>(),
};
