import { afterEach, describe, expect, test } from "bun:test";
import {
  attachInstance,
  detachInstance,
  dropBackground,
  instancesSnapshot,
  publishLabel,
  registerControls,
  setBackgroundPlaying,
  type MusicHand,
  type RaiseInstance,
} from "./instances";

const flush = () => new Promise<void>((r) => queueMicrotask(r));

interface Fake {
  raised: number;
  removed: number;
  raise: RaiseInstance;
}

function fakeOrigin(): Fake {
  const f: Fake = {
    raised: 0,
    removed: 0,
    raise: () => {
      f.raised++;
      return { remove: () => f.removed++ };
    },
  };
  return f;
}

function hand(kept: boolean) {
  const calls = { adopt: 0, release: 0 };
  const music: MusicHand = {
    adopt: () => {
      calls.adopt++;
      return kept;
    },
    release: () => calls.release++,
  };
  return { music, calls };
}

function transport(playing: boolean) {
  const t = { playing };
  return {
    t,
    controls: {
      isPlaying: () => t.playing,
      setPlaying: (p: boolean) => (t.playing = p),
    },
  };
}

const live: string[] = [];
let n = 0;
function key(): string {
  const k = `tab-${n++}`;
  live.push(k);
  return k;
}

afterEach(async () => {
  // Leave no background instance for the next test.
  for (const k of live.splice(0)) dropBackground(k);
  await flush();
});

describe("playback instances", () => {
  test("a re-attach within the same task keeps the instance (a remount)", async () => {
    const origin = fakeOrigin();
    const { music } = hand(true);
    const k = key();
    attachInstance(k, origin.raise, music);
    detachInstance(k, music);
    attachInstance(k, origin.raise, music);
    await flush();
    expect(origin.raised).toBe(1);
    expect(origin.removed).toBe(0);
  });

  test("leaving while paused ends the instance", async () => {
    const origin = fakeOrigin();
    const { music, calls } = hand(true);
    const k = key();
    attachInstance(k, origin.raise, music);
    registerControls(k, transport(false).controls);
    detachInstance(k, music);
    await flush();
    expect(calls.adopt).toBe(0);
    expect(origin.removed).toBe(1);
  });

  test("leaving while playing, not kept across apps, ends it", async () => {
    const origin = fakeOrigin();
    const { music, calls } = hand(false);
    const k = key();
    attachInstance(k, origin.raise, music);
    registerControls(k, transport(true).controls);
    detachInstance(k, music);
    await flush();
    expect(calls.adopt).toBe(1);
    expect(origin.removed).toBe(1);
    expect(instancesSnapshot().background).toBeNull();
  });

  test("leaving while playing, kept, plays on in the background; coming back releases it", async () => {
    const origin = fakeOrigin();
    const { music, calls } = hand(true);
    const k = key();
    attachInstance(k, origin.raise, music);
    const { t, controls } = transport(true);
    registerControls(k, controls);
    publishLabel(k, { title: "Clair de lune", href: "/sonata/song/s1" });
    detachInstance(k, music);
    await flush();
    expect(origin.removed).toBe(0);
    expect(instancesSnapshot().background).toBe(k);
    expect(instancesSnapshot().labels.get(k)).toEqual({
      title: "Clair de lune",
      href: "/sonata/song/s1",
    });

    setBackgroundPlaying(false);
    expect(t.playing).toBe(false);
    setBackgroundPlaying(true);
    expect(t.playing).toBe(true);

    attachInstance(k, origin.raise, music);
    expect(calls.release).toBe(1);
    expect(instancesSnapshot().background).toBeNull();
    expect(origin.raised).toBe(1);
    expect(t.playing).toBe(true);
  });

  test("one background instance: a second pauses and ends the first", async () => {
    const origin = fakeOrigin();
    const { music } = hand(true);
    const a = key();
    const b = key();
    attachInstance(a, origin.raise, music);
    attachInstance(b, origin.raise, music);
    const ta = transport(true);
    const tb = transport(true);
    registerControls(a, ta.controls);
    registerControls(b, tb.controls);
    detachInstance(a, music);
    await flush();
    detachInstance(b, music);
    await flush();
    expect(instancesSnapshot().background).toBe(b);
    expect(ta.t.playing).toBe(false);
    expect(origin.removed).toBe(1);
  });

  test("the service letting go pauses and ends a background instance", async () => {
    const origin = fakeOrigin();
    const { music } = hand(true);
    const k = key();
    attachInstance(k, origin.raise, music);
    const { t, controls } = transport(true);
    registerControls(k, controls);
    detachInstance(k, music);
    await flush();
    dropBackground(k);
    expect(t.playing).toBe(false);
    expect(origin.removed).toBe(1);
    expect(instancesSnapshot().background).toBeNull();
  });
});
