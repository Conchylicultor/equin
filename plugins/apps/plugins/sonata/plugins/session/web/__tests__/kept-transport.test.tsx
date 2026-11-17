import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { useState } from "react";
import {
  PluginProvider,
  type LoadedPlugin,
} from "@plugins/framework/plugins/web-sdk/core";
import {
  emptyScore,
  type Score,
} from "@plugins/apps/plugins/sonata/plugins/score/core";
import {
  flushKept,
  KeepScope,
} from "@plugins/primitives/plugins/kept-state/web";
import {
  installStorage,
  QuotaStorage,
} from "@plugins/primitives/plugins/dom/plugins/web-storage/web/testing";
import { SonataSession } from "../slots";
import {
  CursorStoreProvider,
  useCursorApi,
  type CursorApi,
} from "../cursor-store";
import {
  PlaybackSession,
  useSession,
  type SessionContent,
  type SessionValue,
} from "../session";

beforeAll(() => {
  installStorage("local", new QuotaStorage());
  installStorage("session", new QuotaStorage());
});
// The transport only needs rAF to exist; a frame never has to fire here.
beforeEach(() => {
  vi.stubGlobal("requestAnimationFrame", () => 1);
  vi.stubGlobal("cancelAnimationFrame", () => undefined);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** A 4/4 song of one note per beat over `[0, beats)`. */
function song(beats: number): Score {
  return {
    ...emptyScore(),
    tracks: [{ id: "t" }],
    tempoMap: [{ beat: 0, bpm: 120 }],
    timeSigMap: [{ beat: 0, numerator: 4, denominator: 4 }],
    notes: Array.from({ length: beats }, (_, i) => ({
      id: `n${i}`,
      pitch: 60,
      start: i,
      duration: 1,
      velocity: 80,
      track: "t",
    })),
  };
}

const sessionPlugin: LoadedPlugin[] = [
  {
    id: "apps.sonata.session",
    description: "sonata session fixture",
    slots: SonataSession,
    contributions: [],
  } as unknown as LoadedPlugin,
];

interface Loaded {
  content: SessionContent;
  keepAs: string | null;
}

/** A session mounted in the place `tab`, its content (and song name) set by the test. */
function mountIn(tab: string) {
  let session: SessionValue | null = null;
  let cursor: CursorApi | null = null;
  let setLoaded: ((l: Loaded) => void) | null = null;
  function Probe() {
    session = useSession();
    cursor = useCursorApi();
    return null;
  }
  function Harness() {
    const [loaded, set] = useState<Loaded>({
      content: { kind: "empty", contentKey: {} },
      keepAs: null,
    });
    setLoaded = set;
    return (
      <PlaybackSession content={loaded.content} keepAs={loaded.keepAs}>
        <Probe />
      </PlaybackSession>
    );
  }
  const view = render(
    <PluginProvider plugins={sessionPlugin}>
      <KeepScope segment={`t:${tab}`}>
        <CursorStoreProvider>
          <Harness />
        </CursorStoreProvider>
      </KeepScope>
    </PluginProvider>,
  );
  const must = <T,>(v: T | null): T => {
    if (v === null) throw new Error("session not rendered");
    return v;
  };
  return {
    session: () => must(session),
    beat: () => must(cursor).getBeat(),
    load: (keepAs: string, beats = 32) =>
      act(() =>
        must(setLoaded)({
          content: { kind: "ready", contentKey: {}, score: song(beats) },
          keepAs,
        }),
      ),
    /** The page goes away: the place's session unmounts, pending writes land. */
    leave: () => {
      view.unmount();
      flushKept();
    },
  };
}

describe("playback session: the kept playhead", () => {
  it("a remount resumes the same song paused at its playhead, loop and tempo", () => {
    const first = mountIn("tab-resume");
    first.load("library:a");
    act(() => first.session().seekTo(9));
    act(() => first.session().setLoop({ start: 8, end: 16, enabled: true }));
    act(() => first.session().setTempoScale(0.5));
    act(() => first.session().play());
    expect(first.session().isPlaying).toBe(true);
    first.leave();

    const again = mountIn("tab-resume");
    // Nothing loaded yet: the tempo is back, the playhead waits for the song.
    expect(again.session().tempoScale).toBe(0.5);
    again.load("library:a");
    expect(again.beat()).toBe(9);
    expect(again.session().loop).toEqual({ start: 8, end: 16, enabled: true });
    expect(again.session().isPlaying).toBe(false);

    // Given back once: the next load is a new song, parked at its lead-in.
    again.load("library:a");
    expect(again.beat()).toBe(-4);
    expect(again.session().loop).toBeNull();
  });

  it("restores nothing into another song, nor in another place", () => {
    const first = mountIn("tab-other");
    first.load("library:a");
    act(() => first.session().seekTo(12));
    first.leave();

    const otherSong = mountIn("tab-other");
    otherSong.load("library:b");
    expect(otherSong.beat()).toBe(-4);
    otherSong.leave();

    const otherPlace = mountIn("tab-elsewhere");
    otherPlace.load("library:a");
    expect(otherPlace.beat()).toBe(-4);
  });

  it("a seek intent re-armed for the same beat keeps the playhead; another beat outranks it", () => {
    const first = mountIn("tab-link");
    act(() => first.session().requestSeekOnLoad(() => 8));
    first.load("library:a");
    expect(first.beat()).toBe(8);
    act(() => first.session().seekTo(20));
    first.leave();

    // A reload re-arms the same deep link: where the user was wins.
    const reload = mountIn("tab-link");
    act(() => reload.session().requestSeekOnLoad(() => 8));
    reload.load("library:a");
    expect(reload.beat()).toBe(20);
    reload.leave();

    // A new link to another bar of the song is honoured.
    const link = mountIn("tab-link");
    act(() => link.session().requestSeekOnLoad(() => 4));
    link.load("library:a");
    expect(link.beat()).toBe(4);
  });
});
