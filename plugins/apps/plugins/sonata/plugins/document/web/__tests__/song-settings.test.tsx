import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import {
  useEffect,
  useSyncExternalStore,
  type ComponentType,
  type ReactNode,
} from "react";
import {
  PluginProvider,
  type Contribution,
  type LoadedPlugin,
} from "@plugins/framework/plugins/web-sdk/core";
import {
  emptyScore,
  type Score,
} from "@plugins/apps/plugins/sonata/plugins/score/core";
import { ResourceError } from "@plugins/primitives/plugins/live-state/core";
import { SonataDocument } from "../slots";
import {
  LoadedSongProvider,
  useLibrarySong,
  useLoadDocument,
  useLoadedRaw,
  useSettledSongSettings,
  useFailSongSetting,
  useSongSetting,
  useWriteSongSetting,
} from "../loaded-song";
import { SongSettingsMount, useMountedSongId } from "../song-setting-mount";
import {
  defineSongSetting,
  type SongSetting,
  type SongSettingKey,
} from "../song-setting";
import {
  chordModeSetting,
  defaultGroove,
  transposeSetting,
  useScoreSettings,
} from "../score-settings";
import {
  SongDocumentProvider,
  useSongDocument,
  type SongDocumentValue,
} from "../document";
import type { SongIdentity } from "../identity";

// The document composer reads the global voicing config; its defaults stand for it
// here (no config server in jsdom).
vi.mock("@plugins/config_v2/web", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useConfig: (descriptor: { defaults: unknown }) => descriptor.defaults,
}));

afterEach(cleanup);

/**
 * The loaded song is ONE state — id, content, per-song settings — so:
 *  - a song's content can never render with another song's settings: loading a
 *    different song replaces both in one write (the settings pending), even
 *    while the player still shows the song that played in the background;
 *  - the score waits on exactly the settings the composition registers
 *    (`SonataDocument.SongSetting`): a composition without a feature never hangs, and
 *    reads that setting's `absent` value;
 *  - a setting cannot be left pending while its observer stays mounted: its
 *    observers mount afresh whenever a different song is loaded (A → B → A in
 *    one tick included), and a reload of the same song clears nothing.
 */

// --- Fixtures ---------------------------------------------------------------

/** A feature's persisted per-song values, as its live read sees them. */
interface FixtureServer<T> {
  /** `songId`'s row arrives. */
  settle(songId: string, value: T): void;
  /** `songId`'s value, `undefined` while it is not known yet. */
  useValue(songId: string): T | undefined;
}

function fixtureServer<T>(): FixtureServer<T> {
  let values = new Map<string, T>();
  const listeners = new Set<() => void>();
  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };
  return {
    settle(songId, value) {
      values = new Map(values).set(songId, value);
      for (const listener of listeners) listener();
    },
    useValue(songId) {
      return useSyncExternalStore(subscribe, () => values.get(songId));
    },
  };
}

/**
 * The observer a feature registers for `key`, shaped like the real ones: it
 * writes the mounted song's value only when its settled read CHANGES — so a
 * setting emptied under it while it stayed mounted would stay pending forever.
 */
function observerOf<T>(
  key: SongSettingKey<T>,
  server: FixtureServer<T>,
  mounts: { count: number } = { count: 0 },
): () => null {
  return function FixtureObserver() {
    const songId = useMountedSongId();
    const write = useWriteSongSetting(key);
    const value = server.useValue(songId);
    useEffect(() => {
      mounts.count++;
    }, []);
    useEffect(() => {
      if (value !== undefined) write(songId, value);
    }, [songId, value, write]);
    return null;
  };
}

/** Register `key` with its observer, as a feature plugin does. */
function register<T>(
  key: SongSettingKey<T>,
  observer: () => null,
): Contribution {
  return SonataDocument.SongSetting({
    id: key.name,
    setting: key,
    component: observer,
  });
}

/** The document declaring its slots; `contributions` are the composition. */
function shellPlugin(contributions: Contribution[]): LoadedPlugin[] {
  return [
    {
      id: "apps.sonata.document",
      description: "sonata document fixture",
      slots: SonataDocument,
      contributions,
    } as unknown as LoadedPlugin,
  ];
}

function renderSurface(plugins: LoadedPlugin[], children: ReactNode) {
  return render(
    <PluginProvider plugins={plugins}>
      <LoadedSongProvider>
        {children}
        <SongSettingsMount />
      </LoadedSongProvider>
    </PluginProvider>,
  );
}

/** Imperative handles on the loaded song, captured from inside the surface. */
interface Handles {
  /** Load library song `songId`. */
  load: (songId: string, rawById: Record<string, unknown>) => void;
  loadDocument: (
    identity: SongIdentity,
    rawById: Record<string, unknown>,
  ) => void;
  writeTranspose: (songId: string, value: number) => void;
}

function captureHandles(): { handles: Handles; Capture: ComponentType } {
  const handles: Handles = {
    load: () => {
      throw new Error("surface not rendered");
    },
    loadDocument: () => {
      throw new Error("surface not rendered");
    },
    writeTranspose: () => {
      throw new Error("surface not rendered");
    },
  };
  function Capture() {
    const loadDocument = useLoadDocument();
    handles.loadDocument = loadDocument;
    handles.load = (songId, rawById) =>
      loadDocument({ kind: "library", songId }, rawById);
    handles.writeTranspose = useWriteSongSetting(transposeSetting);
    return null;
  }
  return { handles, Capture };
}

function last<T>(seen: T[]): T {
  const latest = seen.at(-1);
  if (latest === undefined) throw new Error("nothing rendered yet");
  return latest;
}

// --- The loaded song --------------------------------------------------------

describe("loaded song: content and settings belong to one song", () => {
  it("before any song is loaded a registered setting is pending, and a write is dropped", () => {
    const server = fixtureServer<number>();
    const plugins = shellPlugin([
      register(transposeSetting, observerOf(transposeSetting, server)),
    ]);
    const { handles, Capture } = captureHandles();
    const seen: SongSetting<number>[] = [];
    function Probe() {
      seen.push(useSongSetting(transposeSetting));
      return null;
    }
    renderSurface(plugins, [<Capture key="c" />, <Probe key="p" />]);
    expect(last(seen)).toEqual({ kind: "pending" });
    act(() => handles.writeTranspose("a", 3));
    expect(last(seen)).toEqual({ kind: "pending" });
  });

  it("loading another song replaces its content and settings in one write: no render pairs one song's content with another's settings", () => {
    const server = fixtureServer<number>();
    server.settle("A", 1);
    const plugins = shellPlugin([
      register(transposeSetting, observerOf(transposeSetting, server)),
    ]);
    const { handles, Capture } = captureHandles();
    const seen: { raw: unknown; transpose: SongSetting<number> }[] = [];
    function Probe() {
      const raw = useLoadedRaw();
      const transpose = useSongSetting(transposeSetting);
      seen.push({ raw: raw.fixture, transpose });
      return null;
    }
    renderSurface(plugins, [<Capture key="c" />, <Probe key="p" />]);

    act(() => handles.load("A", { fixture: "a" }));
    expect(last(seen)).toEqual({
      raw: "a",
      transpose: { kind: "settled", value: 1 },
    });

    act(() => handles.load("B", { fixture: "b" }));
    expect(last(seen)).toEqual({ raw: "b", transpose: { kind: "pending" } });

    // A write for the song that is no longer loaded — a late push — is dropped.
    act(() => handles.writeTranspose("A", 9));
    expect(last(seen)).toEqual({ raw: "b", transpose: { kind: "pending" } });

    act(() => server.settle("B", 5));
    expect(last(seen)).toEqual({
      raw: "b",
      transpose: { kind: "settled", value: 5 },
    });

    // Every render paired a song's content with that song's own settings.
    for (const s of seen) {
      if (s.transpose.kind !== "settled") continue;
      expect(s.transpose.value).toBe(s.raw === "a" ? 1 : 5);
    }
  });

  it("a reload of the same song keeps its settled settings and its observers", () => {
    const server = fixtureServer<number>();
    server.settle("A", 1);
    const mounts = { count: 0 };
    const plugins = shellPlugin([
      register(transposeSetting, observerOf(transposeSetting, server, mounts)),
    ]);
    const { handles, Capture } = captureHandles();
    const seen: { raw: unknown; transpose: SongSetting<number> }[] = [];
    function Probe() {
      const raw = useLoadedRaw();
      seen.push({
        raw: raw.fixture,
        transpose: useSongSetting(transposeSetting),
      });
      return null;
    }
    renderSurface(plugins, [<Capture key="c" />, <Probe key="p" />]);

    act(() => handles.load("A", { fixture: "a" }));
    const rendersSettled = seen.length;
    act(() => handles.load("A", { fixture: "a2" }));
    expect(mounts.count).toBe(1);
    // Not one render of the reloaded content went pending.
    expect(seen.slice(rendersSettled)).toEqual([
      { raw: "a2", transpose: { kind: "settled", value: 1 } },
    ]);
  });

  it("a song loaded again after another in the same tick (A → B → A) is settled again, never stuck pending", () => {
    const server = fixtureServer<number>();
    server.settle("A", 1);
    server.settle("B", 5);
    const mounts = { count: 0 };
    const plugins = shellPlugin([
      register(transposeSetting, observerOf(transposeSetting, server, mounts)),
    ]);
    const { handles, Capture } = captureHandles();
    const seen: SongSetting<number>[] = [];
    function Probe() {
      seen.push(useSongSetting(transposeSetting));
      return null;
    }
    renderSurface(plugins, [<Capture key="c" />, <Probe key="p" />]);

    act(() => handles.load("A", { fixture: "a" }));
    expect(last(seen)).toEqual({ kind: "settled", value: 1 });

    // The B load empties the settings and the A load empties them again, while
    // the loaded id reads "A" before and after: the observer — which writes only
    // on a CHANGED read — must still remount, or A would stay pending forever.
    act(() => {
      handles.load("B", { fixture: "b" });
      handles.load("A", { fixture: "a" });
    });
    expect(mounts.count).toBe(2);
    expect(last(seen)).toEqual({ kind: "settled", value: 1 });
  });

  it("an unchanged value does not re-render readers", () => {
    const server = fixtureServer<number>();
    const plugins = shellPlugin([
      register(transposeSetting, observerOf(transposeSetting, server)),
    ]);
    const { handles, Capture } = captureHandles();
    const seen: SongSetting<number>[] = [];
    function Probe() {
      seen.push(useSongSetting(transposeSetting));
      return null;
    }
    renderSurface(plugins, [<Capture key="c" />, <Probe key="p" />]);
    act(() => handles.load("A", {}));
    act(() => handles.writeTranspose("A", 3));
    const renders = seen.length;
    act(() => handles.writeTranspose("A", 3));
    expect(seen.length).toBe(renders);
  });
});

// --- The gate ---------------------------------------------------------------

/** A setting only its own feature reads — like the track-mixer's track view. */
const extraSetting = defineSongSetting<string>("extra", "none");
const ONLY_TRANSPOSE = { transposeSemitones: transposeSetting };

describe("the score gate waits on the registered settings, and only on them", () => {
  it("waits on every registered setting, including those it does not read", () => {
    const transposes = fixtureServer<number>();
    const extras = fixtureServer<string>();
    const plugins = shellPlugin([
      register(transposeSetting, observerOf(transposeSetting, transposes)),
      register(extraSetting, observerOf(extraSetting, extras)),
    ]);
    const { handles, Capture } = captureHandles();
    const seen: SongSetting<{ transposeSemitones: number }>[] = [];
    function Probe() {
      seen.push(useSettledSongSettings(ONLY_TRANSPOSE));
      return null;
    }
    renderSurface(plugins, [<Capture key="c" />, <Probe key="p" />]);

    act(() => handles.load("A", {}));
    act(() => transposes.settle("A", 2));
    expect(last(seen)).toEqual({ kind: "pending" });
    act(() => extras.settle("A", "x"));
    expect(last(seen)).toEqual({
      kind: "settled",
      value: { transposeSemitones: 2 },
    });
  });

  it("does not hang on a setting no feature registers: it reads as its absent value", () => {
    const transposes = fixtureServer<number>();
    // Only the transpose feature is in this composition: no key mode, chord
    // mode, groove or track view.
    const plugins = shellPlugin([
      register(transposeSetting, observerOf(transposeSetting, transposes)),
    ]);
    const { handles, Capture } = captureHandles();
    const seen: ReturnType<typeof useScoreSettings>[] = [];
    const chordMode: SongSetting<boolean>[] = [];
    function Probe() {
      seen.push(useScoreSettings());
      chordMode.push(useSongSetting(chordModeSetting));
      return null;
    }
    renderSurface(plugins, [<Capture key="c" />, <Probe key="p" />]);

    act(() => handles.load("A", {}));
    expect(last(seen)).toEqual({ kind: "pending" });
    act(() => transposes.settle("A", 3));
    expect(last(seen)).toEqual({
      kind: "settled",
      value: {
        transposeSemitones: 3,
        keyAutoDetect: false,
        groove: defaultGroove(),
        chordMode: false,
        swing: { kind: "score" },
      },
    });
    expect(last(chordMode)).toEqual({ kind: "settled", value: false });
  });

  it("a registered setting whose read failed fails the gate — with its retry — until a value lands", () => {
    const transposes = fixtureServer<number>();
    const extras = fixtureServer<string>();
    const failure = {
      error: new ResourceError("loader-failed", "boom", undefined),
      refetch: () => Promise.resolve(),
    };
    // The extra feature's observer, shaped like the real ones: its read
    // FAILED with nothing to settle from, so it reports the failure.
    function FailingObserver() {
      const songId = useMountedSongId();
      const fail = useFailSongSetting(extraSetting);
      const write = useWriteSongSetting(extraSetting);
      const value = extras.useValue(songId);
      useEffect(() => {
        if (value === undefined) fail(songId, failure);
        else write(songId, value);
      }, [songId, value, fail, write]);
      return null;
    }
    const plugins = shellPlugin([
      register(transposeSetting, observerOf(transposeSetting, transposes)),
      register(extraSetting, FailingObserver),
    ]);
    const { handles, Capture } = captureHandles();
    const gate: SongSetting<{ transposeSemitones: number }>[] = [];
    const extra: SongSetting<string>[] = [];
    function Probe() {
      gate.push(useSettledSongSettings(ONLY_TRANSPOSE));
      extra.push(useSongSetting(extraSetting));
      return null;
    }
    renderSurface(plugins, [<Capture key="c" />, <Probe key="p" />]);

    act(() => handles.load("A", {}));
    // Failed beats pending: the gate fails even while transpose still loads.
    expect(last(gate)).toEqual({ kind: "failed", ...failure });
    expect(last(extra)).toEqual({ kind: "failed", ...failure });
    act(() => transposes.settle("A", 2));
    expect(last(gate)).toEqual({ kind: "failed", ...failure });

    // The retry lands a value: the failure clears and the gate settles.
    act(() => extras.settle("A", "x"));
    expect(last(extra)).toEqual({ kind: "settled", value: "x" });
    expect(last(gate)).toEqual({
      kind: "settled",
      value: { transposeSemitones: 2 },
    });
  });

  it("settles on load when the composition registers no setting at all", () => {
    const { handles, Capture } = captureHandles();
    const seen: ReturnType<typeof useScoreSettings>[] = [];
    function Probe() {
      seen.push(useScoreSettings());
      return null;
    }
    renderSurface(shellPlugin([]), [<Capture key="c" />, <Probe key="p" />]);
    expect(last(seen)).toEqual({ kind: "pending" });
    act(() => handles.load("A", {}));
    expect(last(seen)).toMatchObject({
      kind: "settled",
      value: { transposeSemitones: 0 },
    });
  });
});

// --- The composed document: the reported song switch -------------------------

/** A one-note score at `pitch` — so a rendered score shows the transpose applied. */
function oneNote(pitch: number): Score {
  return {
    ...emptyScore(),
    tracks: [{ id: "t" }],
    tempoMap: [{ beat: 0, bpm: 120 }],
    timeSigMap: [{ beat: 0, numerator: 4, denominator: 4 }],
    notes: [
      { id: "n", pitch, start: 0, duration: 1, velocity: 80, track: "t" },
    ],
  };
}

const fixtureSource = SonataDocument.Source({
  id: "fixture",
  label: "Fixture",
  LoaderComponent: () => null,
  compile: (raw) => oneNote(raw as number),
});

/** Render a composed document; returns a live getter on it. */
function renderDocument(plugins: LoadedPlugin[]): {
  doc: () => SongDocumentValue;
  load: (identity: SongIdentity, rawById: Record<string, unknown>) => void;
  pitches: number[][];
} {
  let ctx: SongDocumentValue | null = null;
  let loadDocument: Handles["loadDocument"] | null = null;
  const pitches: number[][] = [];
  function Probe() {
    ctx = useSongDocument();
    loadDocument = useLoadDocument();
    const { content } = ctx;
    pitches.push(
      content.kind === "ready" ? content.score.notes.map((n) => n.pitch) : [],
    );
    return null;
  }
  render(
    <PluginProvider plugins={plugins}>
      <SongDocumentProvider>
        <Probe />
        <SongSettingsMount />
      </SongDocumentProvider>
    </PluginProvider>,
  );
  return {
    doc: () => {
      if (ctx === null) throw new Error("document not rendered");
      return ctx;
    },
    load: (identity, rawById) => {
      if (loadDocument === null) throw new Error("document not rendered");
      loadDocument(identity, rawById);
    },
    pitches,
  };
}

describe("the composed document: a song's content only ever renders with its own settings", () => {
  it("background-playing A, then opening B: B never renders with A's settings, nor A with B's", () => {
    const transposes = fixtureServer<number>();
    transposes.settle("A", 1);
    const { doc, load, pitches } = renderDocument(
      shellPlugin([
        fixtureSource,
        register(transposeSetting, observerOf(transposeSetting, transposes)),
      ]),
    );
    const A: SongIdentity = { kind: "library", songId: "A" };
    const B: SongIdentity = { kind: "library", songId: "B" };

    // The library's background play of A.
    act(() => load(A, { fixture: 60 }));
    expect(last(pitches)).toEqual([61]);

    // B's card: the player pane loads B — its settings pending meanwhile.
    act(() => load(B, { fixture: 70 }));
    expect(doc().content.kind).toBe("pending");
    expect(last(pitches)).toEqual([]);
    act(() => transposes.settle("B", 5));
    expect(last(pitches)).toEqual([75]);

    // Once more: background-play A again, then open B — B's settings are
    // already known this time.
    act(() => load(A, { fixture: 60 }));
    expect(last(pitches)).toEqual([61]);
    act(() => load(B, { fixture: 70 }));
    expect(last(pitches)).toEqual([75]);

    // No render ever composed B's content under A's offset (71), nor A's under
    // B's (65).
    const all = pitches.flat();
    expect(all).not.toContain(71);
    expect(all).not.toContain(65);
  });

  it("a view transform keeps the content key; new content moves it", () => {
    const transposes = fixtureServer<number>();
    transposes.settle("A", 0);
    const { doc, load } = renderDocument(
      shellPlugin([
        fixtureSource,
        register(transposeSetting, observerOf(transposeSetting, transposes)),
      ]),
    );
    act(() => load({ kind: "library", songId: "A" }, { fixture: 60 }));
    const key = doc().content.contentKey;
    act(() => transposes.settle("A", 2));
    expect(doc().content.kind).toBe("ready");
    expect(doc().content.contentKey).toBe(key);
    act(() => load({ kind: "library", songId: "A" }, { fixture: 62 }));
    expect(doc().content.contentKey).not.toBe(key);
  });
});

// --- File documents -----------------------------------------------------------

describe("a file document: its settings are its defaults, read-only", () => {
  it("settles every registered setting to its default at load, mounting no observer", () => {
    const transposes = fixtureServer<number>();
    transposes.settle("song", 7);
    const mounts = { count: 0 };
    const plugins = shellPlugin([
      fixtureSource,
      register(
        transposeSetting,
        observerOf(transposeSetting, transposes, mounts),
      ),
      register(chordModeSetting, observerOf(chordModeSetting, fixtureServer())),
    ]);
    const { doc, load, pitches } = renderDocument(plugins);

    act(() => load({ kind: "file", key: "song" }, { fixture: 60 }));
    expect(mounts.count).toBe(0);
    expect(doc().content.kind).toBe("ready");
    // The transpose default (0) — never the library song "song"'s 7.
    expect(last(pitches)).toEqual([60]);
  });

  it("drops every setting write, and useLibrarySong reads none", () => {
    const plugins = shellPlugin([
      register(transposeSetting, observerOf(transposeSetting, fixtureServer())),
    ]);
    const { handles, Capture } = captureHandles();
    const seen: SongSetting<number>[] = [];
    const songs: ReturnType<typeof useLibrarySong>[] = [];
    function Probe() {
      seen.push(useSongSetting(transposeSetting));
      songs.push(useLibrarySong());
      return null;
    }
    renderSurface(plugins, [<Capture key="c" />, <Probe key="p" />]);
    expect(last(songs)).toEqual({ kind: "none" });

    act(() => handles.loadDocument({ kind: "file", key: "x" }, {}));
    expect(last(seen)).toEqual({ kind: "settled", value: 0 });
    expect(last(songs)).toEqual({ kind: "none" });
    // A write naming the file's key as a song id is not a library song's.
    act(() => handles.writeTranspose("x", 4));
    expect(last(seen)).toEqual({ kind: "settled", value: 0 });

    act(() => handles.load("A", {}));
    expect(last(songs)).toEqual({ kind: "library", songId: "A" });
  });
});
