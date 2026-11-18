import type { ComponentType } from "react";
import type { FetchEndpoint } from "@plugins/infra/plugins/endpoints/web";
import type { LiveReader } from "@plugins/network/plugins/live/web";
import type { OpenDialog } from "@plugins/primitives/plugins/overlay/plugins/imperative-dialog/web";
import type { Hook } from "@plugins/framework/plugins/hook-value/core";
import type { ResourceResult } from "@plugins/network/plugins/live/plugins/live-state/web";
import { defineSlot } from "@plugins/framework/plugins/web-sdk/core";
import { defineRenderSlot } from "@plugins/primitives/plugins/slot-render/web";
import {
  defineItemActions,
  type CoverContent,
  type CreateOption,
} from "@plugins/primitives/plugins/data-view/web";
import type { Song, SongId, SongLinkKey } from "../core";
import type { OpenSong } from "./open-song";

/**
 * Extension seams the song library exposes:
 *
 *  - `Source` — the source registry. Each input source (MIDI, chord-grid, …)
 *    contributes how it persists/hydrates a song, so the library stays fully
 *    source-agnostic (the collection–consumer separation). `useHydration(songId)`
 *    reads that source's client raw for the song live (absent, raw or pending —
 *    {@link SourceHydration} — as a `ResourceResult`, so not-known-yet and a
 *    failed read stay states); `SongHydrator` renders one hook per
 *    contribution and folds them, so a song opens once every source answered.
 *    The optional `createOption` is a data-view {@link CreateOption} whose
 *    `onSelect` takes the {@link SourceContext} — an "add a song of this
 *    source" affordance the library binds and maps into the gallery's
 *    `creators` (a toolbar "+" menu, since there are N sources). Its `onSelect`
 *    runs fully imperatively (no React hooks): create the song, then
 *    `ctx.openSong`. It runs outside React, so the library hands it the
 *    fetcher bound to the surface's transport (`ctx.fetchEndpoint`) — for its
 *    writes; a read is live, never fetched.
 *    Adding a new source = a new contribution here, with zero library or
 *    core-schema changes.
 *  - `Cover` — each source's answer to "what is this song's cover?"
 *    ({@link SongCoverAnswer}), folded by the library into the one cover every
 *    view draws (the gallery card's picture, the list row's thumbnail).
 *  - `SongActions` — the ONE per-row action set for the library, rendered by
 *    EVERY view: the gallery card, the list row and the table row. An action
 *    declares where it belongs with `zone` — `"primary"` (the row's main verb:
 *    the round button over the cover), `"persistent"` (painted at rest) or the
 *    default `"revealed"` (the hover cluster). There is no per-view action
 *    list, so an action added here can never reach one view and miss another.
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

/**
 * What the library hands a source's imperative `createOption.onSelect`, bound
 * to the surface the library renders in, so a source never reaches past it:
 *
 * - `fetchEndpoint` — the fetcher of the surface's transport. For writes only —
 *   it refuses a read (a GET) at compile time; reads are live (`useHydration`).
 * - `readLive` — the surface's live reader, for the one answer an imperative
 *   step needs (a share link's tab fetched before its song is created).
 * - `openDialog` — the dialog opener of the surface's render origin: a dialog
 *   a source opens renders where the library is (inside the demo, against the
 *   demo's server), never in the page around it.
 * - `openSong` — opens a song into the player in the surface's tab set (inside
 *   the demo, the demo's), starting it: what a create affordance calls once
 *   its song is made. There is no free opener to reach for instead.
 */
export interface SourceContext {
  fetchEndpoint: FetchEndpoint;
  readLive: LiveReader;
  openDialog: OpenDialog;
  openSong: OpenSong;
}

/**
 * One source's answer to "what is this song's cover?" (`Library.Cover`):
 *
 * - `art` — the picture (`content`, a data-view `CoverContent`: an image URL,
 *   or a node the source draws itself — a chord grid in the theme's colours).
 * - `pending` — the source HAS a cover for the song but it is not ready yet
 *   (a transcription still running); `label` says what is under way.
 * - `failed` — the source should have a cover and could not make it;
 *   `message` says why.
 *
 * A source with nothing to say about the song (not its source, no artwork)
 * returns `undefined` — never a stand-in `art`.
 */
export type SongCoverAnswer =
  | { kind: "art"; content: CoverContent }
  | { kind: "pending"; label: string }
  | { kind: "failed"; message: string };

/** A source's create affordance: a data-view `CreateOption` whose `onSelect` takes the {@link SourceContext}. */
export type SourceCreateOption = Omit<
  CreateOption,
  "onSelect" | "activation"
> & {
  onSelect: (ctx: SourceContext) => void | Promise<unknown>;
};

/**
 * What a `Library.SongLink` contribution's link part reads for the open song:
 * not known yet (its data is still loading — no link is offered meanwhile),
 * or known — the text to carry, or `null` to carry none (the song's own
 * default, which a link need not spell).
 */
export type SongLinkValue =
  { known: false } | { known: true; value: string | null };

export const Library = {
  Source: defineSlot<{
    /** Stable id of the source (matches its `SonataDocument.Source` id / `rawById` key). */
    sourceId: string;
    /**
     * This source's client raw for `songId`, absent, or pending (see
     * {@link SourceHydration}), read live: `loading` until every read it makes
     * answered, `error` when one failed — never a stand-in `absent`.
     */
    useHydration: Hook<(songId: string) => ResourceResult<SourceHydration>>;
    /**
     * Optional create affordance for this source, mapped by the library into the
     * data-view `creators` (toolbar "+" menu). Plain data — `onSelect` runs
     * imperatively (create + `ctx.openSong`), no React hooks.
     */
    createOption?: SourceCreateOption;
  }>({ docLabel: (c) => c.sourceId }),
  /**
   * The song's share link, one part per contribution: each owns one key of
   * the player route ({@link SongLinkKey}) — what it writes there, and what
   * it does with a link's value when the link names a song this library does
   * not have. The library collects them generically and never names one.
   *
   * - `useValue` — run inside the player while the song is loaded: the text
   *   this part of the song spells in its link (`null`: none — the default).
   *   The player's Share button copies a link with every part, and the song's
   *   title beside them — offered only once a `create` part has a value (a
   *   song another library can be given).
   * - `create` — set on a part that can bring a song into being (a chord grid,
   *   an Ultimate Guitar tab): creates the song with the link's id, title and
   *   this value.
   * - `apply` — writes this part's link value onto a song just created from
   *   the link. A value it cannot read is skipped (a link is typed, pasted or
   *   stale — like `;bar`), so the song still opens.
   *
   * A song this library HAS keeps its own content: a link only fills in a song
   * that is missing (the stored song is never older than a link to it from
   * this library, so it wins).
   */
  SongLink: defineSlot<{
    key: SongLinkKey;
    useValue: Hook<() => SongLinkValue>;
    create?: (
      ctx: SourceContext,
      song: { id: SongId; title: string; value: string },
    ) => Promise<void>;
    apply?: (
      ctx: SourceContext,
      song: { id: SongId; value: string },
    ) => Promise<void>;
  }>({ docLabel: (c) => c.key }),
  /**
   * The cover seam: each contribution answers for the songs it knows
   * (`cover(song)`, a hook-free read of the row — it is called per card per
   * render). The library folds every answer through `resolveSongCover`
   * (failed > pending > art; two arts for one song throw) and paints it on top
   * of the quiet source-tinted base `SongCover` always draws, so a song no
   * contribution answers for still has a cover. The library never names a
   * source (collection–consumer rule).
   */
  Cover: defineSlot<{
    id: string;
    cover: (song: Song) => SongCoverAnswer | undefined;
  }>({ docLabel: (c) => c.id }),
  /**
   * Per-row actions for the library (Play/Pause, Delete). Minted here,
   * contributed in `web/index.ts`, and passed to the one `DataView` as
   * `itemActions`, so the gallery card, the list row and the table row show
   * the same set — Play is the row's primary verb (`zone: "primary"`: the round
   * button over the cover, at rest while its song plays), Delete on hover.
   */
  SongActions: defineItemActions<Song>(),
  /**
   * Notices about the library's songs that no song can say itself — a source
   * that cannot be read (a watched folder macOS denied). Drawn between the
   * toolbar and the songs, and above the first-run onboarding when there is no
   * song (an unreadable folder is exactly why a library can be empty). A
   * contribution renders nothing when it has nothing to say, and owns the room
   * under itself (the slot adds no spacing). The library never names a source.
   */
  Notice: defineRenderSlot<{ component: ComponentType }>({
    docLabel: (c) => c.id,
  }),
};
