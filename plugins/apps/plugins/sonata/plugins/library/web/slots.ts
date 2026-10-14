import type { ComponentType } from "react";
import { defineSlot } from "@plugins/framework/plugins/web-sdk/core";
import {
  defineFieldExtensions,
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
 *  - `Fields` — extra DataView `FieldDef<Song>[]` injected by other plugins. A
 *    field extension is a *component* (not plain data), though the library's
 *    contributors need no hook: `playback-history` reads its play-count /
 *    last-played columns off the song row (`playbackColumns.read`, the
 *    `$columns` its `LiveColumns.Serve` folds in) and binds each field to
 *    `playbackColumns.column(…)`. Contributed fields show
 *    up in the Sort pill, the Filter pill, and as table columns for free, so a
 *    prerecorded "Most played" ordering is just a named `SortRule[]` over the
 *    `playCount` field (a config sort preset) rather than a bespoke toggle chip.
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
  Fields: defineFieldExtensions<Song>(),
};
