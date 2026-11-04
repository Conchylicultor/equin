import { useMemo, type ReactNode } from "react";
import { defineScopedStore } from "@plugins/primitives/plugins/scope/plugins/scoped-store/web";
import { SonataDocument } from "./slots";
import { sameIdentity, type SongIdentity } from "./identity";
import type {
  SongSetting,
  SongSettingFailure,
  SongSettingKey,
} from "./song-setting";

/**
 * The song document a surface has loaded — its identity, its content (every
 * source's raw input) and its per-song settings — as ONE state under ONE
 * identity. There is no way to hold one song's content with another song's
 * settings: loading a different document replaces all three at once, its
 * settings starting empty (pending), and a setting can only be written for the
 * library song held.
 */
interface LoadedSong {
  identity: SongIdentity;
  /**
   * Bumped whenever a DIFFERENT document is loaded — never by a reload of the
   * same one, which keeps its settings. The settings' observers mount keyed on it
   * (`SongSettingsMount`), so whenever a song's settings start empty its
   * observers mount afresh and settle them: even a song loaded again after
   * another one in the same tick (A → B → A), whose id alone would not change.
   */
  generation: number;
  /**
   * Bumped by EVERY load — a reload of the same document included (its sources
   * re-hydrated), unlike `generation`. What a once-per-load effect keys on (a
   * play is counted once per load — {@link useLibrarySongLoad}).
   */
  loads: number;
  /** Each source's raw input, by source id. */
  rawById: Readonly<Record<string, unknown>>;
  /**
   * Each source's raw input as the last load handed it — what `rawById` holds
   * until an edit. A source whose raw is not this one has been edited since
   * the load (see {@link useSourceEdit}).
   */
  loadedRawById: Readonly<Record<string, unknown>>;
  /**
   * The song's settled settings — a setting not in here is pending (or
   * failed). Always empty for a file document, whose settings all read their
   * `absent` value (see {@link readSetting}).
   */
  settings: ReadonlyMap<SongSettingKey<unknown>, unknown>;
  /**
   * Settings whose observer's read FAILED with no last-known value to settle
   * from. A later settled write clears the entry.
   */
  failures: ReadonlyMap<SongSettingKey<unknown>, SongSettingFailure>;
}

const loadedSongStore = defineScopedStore<LoadedSong | null>(null);

const NO_RAW: Readonly<Record<string, unknown>> = {};
const NO_SETTINGS: ReadonlyMap<SongSettingKey<unknown>, unknown> = new Map();
const NO_FAILURES: ReadonlyMap<
  SongSettingKey<unknown>,
  SongSettingFailure
> = new Map();
const NO_REGISTERED: ReadonlySet<SongSettingKey<unknown>> = new Set();
/** The one pending value, shared, so a still-pending read changes nothing a reader sees. */
const PENDING: { kind: "pending" } = { kind: "pending" };

/**
 * Provides one surface's loaded document. Mounted by `SongDocumentProvider`
 * ABOVE the component that composes the document's content (a component
 * cannot use a store its own JSX provides).
 */
export function LoadedSongProvider({ children }: { children: ReactNode }) {
  return <loadedSongStore.Provider>{children}</loadedSongStore.Provider>;
}

// --- Content. ---------------------------------------------------------------

/**
 * Load the document `identity` with its content — the full `{ sourceId: raw }`
 * map, REPLACING the current inputs (not merging), so opening a song never
 * leaves a previously-opened song's source inputs lingering.
 *
 * The identity comes WITH the content because the content, the song and its
 * per-song settings are one state: the same document as the one held keeps
 * its settings (a reload of its sources); any other replaces the identity, the
 * content AND the settings in one write — a library song's pending until its
 * observers settle them. So no render can pair one song's content with another
 * song's settings, whatever song the app shows as open at that moment (a song
 * played in the background, a player not mounted yet).
 */
export function useLoadDocument(): (
  identity: SongIdentity,
  rawById: Readonly<Record<string, unknown>>,
) => void {
  const api = loadedSongStore.useStoreApi();
  return useMemo(
    () =>
      (identity: SongIdentity, rawById: Readonly<Record<string, unknown>>) =>
        api.setState((prev) =>
          prev !== null && sameIdentity(prev.identity, identity)
            ? {
                ...prev,
                loads: prev.loads + 1,
                rawById,
                loadedRawById: rawById,
              }
            : {
                identity,
                generation: (prev?.generation ?? 0) + 1,
                loads: (prev?.loads ?? 0) + 1,
                rawById,
                loadedRawById: rawById,
                settings: NO_SETTINGS,
                failures: NO_FAILURES,
              },
        ),
    [api],
  );
}

/**
 * Edit one source's raw input of the document `identity` — a source editor's
 * write, bound to the document it was derived from. `update` maps the source's
 * CURRENT raw (read at write time, never a render's copy) to its next one, so
 * a write that only changes part of the raw (Ultimate Guitar's alignment)
 * cannot rebuild it from a stale base. Dropped unless `identity` is the
 * document loaded, like a setting write: a writer left over from an earlier
 * song cannot land its content on the next one. Returning the current raw
 * changes nothing. Throws when no document is loaded: an editor only exists
 * inside a loaded song's player, so an edit with none is a broken assumption.
 */
export function useEditSourceRaw(
  identity: SongIdentity | null,
): (sourceId: string, update: (raw: unknown) => unknown) => void {
  const api = loadedSongStore.useStoreApi();
  return useMemo(
    () => (sourceId: string, update: (raw: unknown) => unknown) =>
      api.setState((prev) => {
        if (prev === null || identity === null) {
          throw new Error(
            `Sonata: source "${sourceId}" edited with no song loaded`,
          );
        }
        if (!sameIdentity(prev.identity, identity)) return prev;
        const current = prev.rawById[sourceId];
        const next = update(current);
        if (next === current) return prev;
        return { ...prev, rawById: { ...prev.rawById, [sourceId]: next } };
      }),
    [api, identity],
  );
}

/** The loaded document's raw inputs by source id — none before a load. */
export function useLoadedRaw(): Readonly<Record<string, unknown>> {
  return loadedSongStore.useSelector((s) => s?.rawById ?? NO_RAW, []);
}

/**
 * One source's edit of the loaded library song: its raw input WITH the song
 * and the load it belongs to, read as one value — so a persist can only ever
 * save a song's content under that song's id. `unedited` while the source's
 * raw is the one the load handed (a load is not an edit, so there is no echo
 * to skip), and for a file document (nothing of it is persisted).
 *
 *  - `load`: which load of the song (`LoadedSong.loads`) — bumped by a reload
 *    of the same song too, whose raw is the server's again.
 *  - `asLoaded`: the source's raw as that load handed it — the baseline a
 *    source compares against when only part of its raw is user content.
 */
export type SourceEdit =
  | { kind: "unedited" }
  | {
      kind: "edited";
      songId: string;
      load: number;
      raw: unknown;
      asLoaded: unknown;
    };

const UNEDITED: SourceEdit = { kind: "unedited" };

/**
 * The loaded library song's edit of source `sourceId` (see {@link SourceEdit})
 * — what a source's persist observer saves. Changes with every edit of that
 * source, never with another source's.
 */
export function useSourceEdit(sourceId: string): SourceEdit {
  return loadedSongStore.useSelector<SourceEdit>(
    (s) => {
      if (s === null || s.identity.kind !== "library") return UNEDITED;
      const raw = s.rawById[sourceId];
      const asLoaded = s.loadedRawById[sourceId];
      if (raw === asLoaded) return UNEDITED;
      return {
        kind: "edited",
        songId: s.identity.songId,
        load: s.loads,
        raw,
        asLoaded,
      };
    },
    [sourceId],
    (a, b) =>
      a.kind === "unedited"
        ? b.kind === "unedited"
        : b.kind === "edited" &&
          a.songId === b.songId &&
          a.load === b.load &&
          a.raw === b.raw,
  );
}

/** Which document is loaded, and which load of it (see `LoadedSong.generation`). */
export interface LoadedDocument {
  identity: SongIdentity;
  generation: number;
}

/** The loaded document, or `null` before any load. */
export function useLoadedDocument(): LoadedDocument | null {
  return loadedSongStore.useSelector<LoadedDocument | null>(
    (s) =>
      s === null ? null : { identity: s.identity, generation: s.generation },
    [],
    (a, b) =>
      a === null || b === null
        ? a === b
        : a.generation === b.generation && sameIdentity(a.identity, b.identity),
  );
}

/** The library song held, as a setting writer needs it (see `useLibrarySong`). */
export type LibrarySong =
  { kind: "library"; songId: string } | { kind: "none" };

const NO_LIBRARY_SONG: LibrarySong = { kind: "none" };

/**
 * The library song this surface has loaded — `none` before any load and for a
 * file document. Every per-song setting WRITER takes its song id from here:
 * the song whose settings it reads, never the song the app shows as open
 * (which can lag the load by a render). A writer renders nothing for `none`,
 * so a file document — whose settings are read-only defaults — shows no
 * setting editor.
 */
export function useLibrarySong(): LibrarySong {
  return loadedSongStore.useSelector<LibrarySong>(
    (s) =>
      s !== null && s.identity.kind === "library"
        ? { kind: "library", songId: s.identity.songId }
        : NO_LIBRARY_SONG,
    [],
    (a, b) =>
      a.kind === "library"
        ? b.kind === "library" && a.songId === b.songId
        : b.kind === "none",
  );
}

/**
 * The library song loaded, WITH which load of it this is (`LoadedSong.loads`,
 * bumped by a reload of the same song too) — `none` before any load and for a
 * file document. What a once-per-load effect keys on (a play counted once per
 * load), the song and its load read as one value.
 */
export type LibrarySongLoad =
  { kind: "library"; songId: string; load: number } | { kind: "none" };

const NO_LIBRARY_SONG_LOAD: LibrarySongLoad = { kind: "none" };

export function useLibrarySongLoad(): LibrarySongLoad {
  return loadedSongStore.useSelector<LibrarySongLoad>(
    (s) =>
      s !== null && s.identity.kind === "library"
        ? { kind: "library", songId: s.identity.songId, load: s.loads }
        : NO_LIBRARY_SONG_LOAD,
    [],
    (a, b) =>
      a.kind === "library"
        ? b.kind === "library" && a.songId === b.songId && a.load === b.load
        : b.kind === "none",
  );
}

/** Whether `loaded` is the library song `songId` — the only song a setting is written for. */
function holdsLibrarySong(loaded: LoadedSong | null, songId: string): boolean {
  return (
    loaded !== null &&
    loaded.identity.kind === "library" &&
    loaded.identity.songId === songId
  );
}

// --- Settings — read and written by any plugin. -----------------------------

/**
 * The per-song settings the running composition registers: one per
 * `SonataDocument.SongSetting` contribution, each paired with the observer
 * that settles it. Read from the slot, so the document names no feature, and a
 * setting whose feature plugin is absent is never waited on.
 */
function useRegisteredSettings(): ReadonlySet<SongSettingKey<unknown>> {
  const contributions = SonataDocument.SongSetting.useContributions();
  return useMemo(
    () => new Set(contributions.map((c) => c.setting)),
    [contributions],
  );
}

/**
 * `key`'s state in `loaded`: for a file document, its `absent` value — a file
 * has no persisted settings, so the default is the truth and nothing settles
 * it. Otherwise its value once written; else its failure, when its observer
 * reported one; else pending while the composition registers it; else —
 * nothing in this composition persists it — its `absent` value, which is then
 * the truth.
 */
function readSetting<T>(
  loaded: LoadedSong | null,
  key: SongSettingKey<T>,
  registered: ReadonlySet<SongSettingKey<unknown>>,
): SongSetting<T> {
  if (loaded?.identity.kind === "file") {
    return { kind: "settled", value: key.absent };
  }
  if (loaded !== null && loaded.settings.has(key)) {
    // The value was written through `useWriteSongSetting(key)`, typed `T`.
    return { kind: "settled", value: loaded.settings.get(key) as T };
  }
  const failure = loaded?.failures.get(key);
  if (failure !== undefined && registered.has(key)) {
    return { kind: "failed", ...failure };
  }
  if (registered.has(key)) return PENDING;
  return { kind: "settled", value: key.absent };
}

function sameSetting<T>(a: SongSetting<T>, b: SongSetting<T>): boolean {
  switch (a.kind) {
    case "pending":
      return b.kind === "pending";
    case "failed":
      return (
        b.kind === "failed" && a.error === b.error && a.refetch === b.refetch
      );
    case "settled":
      return b.kind === "settled" && Object.is(a.value, b.value);
  }
}

/**
 * Reactive read of one setting for the loaded document — pending until its
 * observer has settled it (see {@link readSetting}).
 */
export function useSongSetting<T>(key: SongSettingKey<T>): SongSetting<T> {
  const registered = useRegisteredSettings();
  return loadedSongStore.useSelector(
    (loaded) => readSetting(loaded, key, registered),
    [key, registered],
    sameSetting,
  );
}

/**
 * Set `songId`'s value of one setting — its observer syncing the persisted
 * value, or a control setting it optimistically. Dropped unless `songId` is
 * the loaded library song, so a late push for a song that is no longer loaded
 * can never land on the next one (nor on a file document). Bails on an
 * unchanged value (no listener fan-out).
 */
export function useWriteSongSetting<T>(
  key: SongSettingKey<T>,
): (songId: string, value: T) => void {
  const api = loadedSongStore.useStoreApi();
  return useMemo(
    () => (songId: string, value: T) =>
      api.setState((prev) => {
        if (prev === null || !holdsLibrarySong(prev, songId)) return prev;
        if (
          prev.settings.has(key) &&
          Object.is(prev.settings.get(key), value)
        ) {
          return prev;
        }
        const settings = new Map(prev.settings);
        settings.set(key, value);
        if (!prev.failures.has(key)) return { ...prev, settings };
        const failures = new Map(prev.failures);
        failures.delete(key);
        return { ...prev, settings, failures };
      }),
    [api, key],
  );
}

/**
 * Report that `songId`'s value of one setting could not be read — its
 * observer's read failed with no last-known value to settle from. The setting
 * then reads `failed` (and so does every gate waiting on it) until a value is
 * written. Dropped unless `songId` is the loaded library song, and ignored once the
 * setting holds a value: a settled value is never un-settled by a failure.
 */
export function useFailSongSetting<T>(
  key: SongSettingKey<T>,
): (songId: string, failure: SongSettingFailure) => void {
  const api = loadedSongStore.useStoreApi();
  return useMemo(
    () => (songId: string, failure: SongSettingFailure) =>
      api.setState((prev) => {
        if (prev === null || !holdsLibrarySong(prev, songId)) return prev;
        if (prev.settings.has(key)) return prev;
        const held = prev.failures.get(key);
        if (
          held !== undefined &&
          held.error === failure.error &&
          held.refetch === failure.refetch
        ) {
          return prev;
        }
        const failures = new Map(prev.failures);
        failures.set(key, failure);
        return { ...prev, failures };
      }),
    [api, key],
  );
}

/** The value types of a record of setting keys. */
export type SongSettingValues<
  K extends Record<string, SongSettingKey<unknown>>,
> = { [P in keyof K]: K[P] extends SongSettingKey<infer T> ? T : never };

function sameValues<V extends object>(
  a: SongSetting<V>,
  b: SongSetting<V>,
): boolean {
  if (a.kind !== "settled" || b.kind !== "settled") return sameSetting(a, b);
  const av = a.value as Record<string, unknown>;
  const bv = b.value as Record<string, unknown>;
  return Object.keys(av).every((k) => Object.is(av[k], bv[k]));
}

/**
 * The loaded document's values of `keys` — for a file document, at once, every
 * one its `absent` value; for a library song, pending until EVERY setting the
 * composition registers has settled for it, not only these: nothing of the
 * song may render or play while any of its settings is still loading (a muted
 * track audible). A registered setting whose read FAILED makes the whole gate
 * `failed` (precedence failed > pending, like `combineResources`), so a surface
 * shows the failure with Retry instead of waiting forever. A setting nobody
 * registers is never waited on, and reads as its `absent` value. Re-renders only when that gate flips or one of `keys`'
 * values changes — never for another setting's value (a fader move).
 *
 * `keys` must be stable (a module constant).
 */
export function useSettledSongSettings<
  K extends Record<string, SongSettingKey<unknown>>,
>(keys: K): SongSetting<SongSettingValues<K>> {
  const registered = useRegisteredSettings();
  return loadedSongStore.useSelector(
    (loaded): SongSetting<SongSettingValues<K>> => {
      if (loaded === null) return PENDING;
      let unsettled = false;
      // A file document has nothing to settle: every setting is its default.
      const waitedOn =
        loaded.identity.kind === "file" ? NO_REGISTERED : registered;
      for (const key of waitedOn) {
        if (loaded.settings.has(key)) continue;
        const failure = loaded.failures.get(key);
        if (failure !== undefined) return { kind: "failed", ...failure };
        unsettled = true;
      }
      if (unsettled) return PENDING;
      const value: Record<string, unknown> = {};
      for (const [name, key] of Object.entries(keys)) {
        const setting = readSetting(loaded, key, registered);
        if (setting.kind !== "settled") return PENDING;
        value[name] = setting.value;
      }
      return { kind: "settled", value: value as SongSettingValues<K> };
    },
    [keys, registered],
    sameValues,
  );
}
