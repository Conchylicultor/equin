import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { useEffect, useState } from "react";
import {
  PluginProvider,
  type LoadedPlugin,
} from "@plugins/framework/plugins/web-sdk/core";
import {
  barStartBeat,
  emptyScore,
  type Score,
} from "@plugins/apps/plugins/sonata/plugins/score/core";
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

// The transport only needs rAF to exist; a frame never has to fire here.
beforeEach(() => {
  vi.stubGlobal("requestAnimationFrame", () => 1);
  vi.stubGlobal("cancelAnimationFrame", () => undefined);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** A 4/4 song of one note per beat over `[0, beats)`, every note at `pitch`. */
function song(beats: number, pitch = 60): Score {
  return {
    ...emptyScore(),
    tracks: [{ id: "t" }],
    tempoMap: [{ beat: 0, bpm: 120 }],
    timeSigMap: [{ beat: 0, numerator: 4, denominator: 4 }],
    notes: Array.from({ length: beats }, (_, i) => ({
      id: `n${i}`,
      pitch,
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

/** A mounted session whose content the test sets. */
function renderSession(initial: SessionContent) {
  let session: SessionValue | null = null;
  let cursor: CursorApi | null = null;
  let setContent: ((c: SessionContent) => void) | null = null;
  function Probe() {
    session = useSession();
    cursor = useCursorApi();
    return null;
  }
  function Harness() {
    const [content, set] = useState(initial);
    setContent = set;
    return (
      <PlaybackSession content={content} keepAs={null}>
        <Probe />
      </PlaybackSession>
    );
  }
  render(
    <PluginProvider plugins={sessionPlugin}>
      <CursorStoreProvider>
        <Harness />
      </CursorStoreProvider>
    </PluginProvider>,
  );
  const must = <T,>(v: T | null): T => {
    if (v === null) throw new Error("session not rendered");
    return v;
  };
  return {
    session: () => must(session),
    beat: () => must(cursor).getBeat(),
    load: (c: SessionContent) => act(() => must(setContent)(c)),
  };
}

describe("playback session: the content reset", () => {
  it("parks at the lead-in on new content, and never rewinds for a view transform", () => {
    const keyA = {};
    const s = renderSession({
      kind: "ready",
      contentKey: keyA,
      score: song(16),
    });
    // One 4/4 bar of lead-in before beat 0.
    expect(s.beat()).toBe(-4);
    act(() => s.session().seekTo(8));
    expect(s.beat()).toBe(8);

    // Same content, re-derived score (a transpose): the playhead stays.
    s.load({ kind: "ready", contentKey: keyA, score: song(16, 62) });
    expect(s.beat()).toBe(8);
    expect(s.session().score.notes[0]?.pitch).toBe(62);

    // New content: back to the lead-in.
    s.load({ kind: "ready", contentKey: {}, score: song(16) });
    expect(s.beat()).toBe(-4);
  });

  it("stops at once for pending content, and resets only once it composes", () => {
    const s = renderSession({ kind: "ready", contentKey: {}, score: song(16) });
    act(() => s.session().seekTo(8));
    act(() => s.session().play());
    expect(s.session().isPlaying).toBe(true);

    const keyB = {};
    s.load({ kind: "pending", contentKey: keyB });
    expect(s.session().isPlaying).toBe(false);
    expect(s.beat()).toBe(8);

    s.load({ kind: "ready", contentKey: keyB, score: song(16) });
    expect(s.beat()).toBe(-4);
  });
});

describe("playback session: the load intents", () => {
  it("seek-on-load parks at the requested beat once the next content composes, once", () => {
    const s = renderSession({ kind: "empty", contentKey: {} });
    act(() => s.session().requestSeekOnLoad(() => 6));

    const keyA = {};
    s.load({ kind: "pending", contentKey: keyA });
    s.load({ kind: "ready", contentKey: keyA, score: song(16) });
    expect(s.beat()).toBe(6);
    expect(s.session().isPlaying).toBe(false);

    // Consumed: the next load parks at the lead-in again.
    s.load({ kind: "ready", contentKey: {}, score: song(16) });
    expect(s.beat()).toBe(-4);
  });

  it("seek-on-load resolves its target against the NEW content's score (a bar of its meter map)", () => {
    const s = renderSession({ kind: "ready", contentKey: {}, score: song(8) });
    act(() =>
      s.session().requestSeekOnLoad((loaded) => barStartBeat(loaded, 3)),
    );
    s.load({ kind: "ready", contentKey: {}, score: song(16) });
    // 4/4: bar 3 starts at beat 8 — past the previous song's end, so the
    // target was read off the loaded song, not the one playing when armed.
    expect(s.beat()).toBe(8);
  });

  it("seek-on-load is clamped to the new timeline", () => {
    const s = renderSession({ kind: "empty", contentKey: {} });
    act(() => s.session().requestSeekOnLoad(() => 99));
    s.load({ kind: "ready", contentKey: {}, score: song(16) });
    expect(s.beat()).toBe(16);
  });

  it("empty content leaves the intents armed for the first real load", () => {
    // A host arms play-on-load in its mount effect, which runs BEFORE the
    // session's (an ancestor's) first reset over the initial empty content.
    let session: SessionValue | null = null;
    function ArmOnMount() {
      session = useSession();
      const { requestPlayOnLoad } = session;
      useEffect(() => requestPlayOnLoad(), [requestPlayOnLoad]);
      return null;
    }
    let setContent: ((c: SessionContent) => void) | null = null;
    function Harness() {
      const [content, set] = useState<SessionContent>({
        kind: "empty",
        contentKey: {},
      });
      setContent = set;
      return (
        <PlaybackSession content={content} keepAs={null}>
          <ArmOnMount />
        </PlaybackSession>
      );
    }
    render(
      <PluginProvider plugins={sessionPlugin}>
        <CursorStoreProvider>
          <Harness />
        </CursorStoreProvider>
      </PluginProvider>,
    );
    act(() => setContent!({ kind: "ready", contentKey: {}, score: song(16) }));
    expect(session!.isPlaying).toBe(true);
  });

  it("seek-on-load composes with play-on-load: the song plays from the requested beat", () => {
    const s = renderSession({ kind: "empty", contentKey: {} });
    act(() => {
      s.session().requestSeekOnLoad(() => 6);
      s.session().requestPlayOnLoad();
    });
    s.load({ kind: "ready", contentKey: {}, score: song(16) });
    expect(s.beat()).toBe(6);
    expect(s.session().isPlaying).toBe(true);
  });
});
