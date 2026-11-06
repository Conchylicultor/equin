import { describe, expect, test } from "bun:test";

import type {
  BundleResolution,
  Staleness,
} from "@plugins/release/plugins/bundles/core";
import { createCandidateObserver } from "./candidate-observer";

const PAIR = { composition: "app", platform: "darwin-arm64" };

/** A refusal: the compute's only filesystem read, with no `compareToHead`. */
const REFUSED = {
  ok: false,
  refusal: {
    kind: "no-releases",
    composition: "app",
    platform: "darwin-arm64",
    compDir: "/x",
    namespace: "ns",
  },
} as unknown as BundleResolution;
const RESOLVED = {
  ok: true,
  manifest: { commitSha: "abc" },
} as unknown as BundleResolution;
const CURRENT = { kind: "current" } as unknown as Staleness;

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function fakeSources() {
  const state = {
    resolution: RESOLVED,
    resolveCalls: 0,
    /** Parks the next `compareToHead` until resolved. */
    compare: null as null | ReturnType<typeof deferred<Staleness>>,
  };
  const observer = createCandidateObserver({
    headSha: async () => "head",
    bundleSignature: async () => "bundle",
    resolve: async () => {
      state.resolveCalls++;
      return state.resolution;
    },
    compareToHead: async () =>
      state.compare ? state.compare.promise : CURRENT,
  });
  return { state, observer };
}

describe("createCandidateObserver", () => {
  test("an unchanged signature is a cache hit", async () => {
    const { state, observer } = fakeSources();
    const a = await observer.get(PAIR);
    const b = await observer.get(PAIR);
    expect(b).toBe(a);
    expect(state.resolveCalls).toBe(1);
  });

  test("a close forces a fresh observation even when the bundle did not move", async () => {
    const { state, observer } = fakeSources();
    const before = await observer.signature(PAIR);
    await observer.get(PAIR);

    const closedAt = new Date();
    observer.noteClosed(PAIR);

    expect(await observer.signature(PAIR)).not.toBe(before);
    const after = await observer.get(PAIR);
    expect(after.observedAt.getTime()).toBeGreaterThanOrEqual(
      closedAt.getTime(),
    );
    expect(state.resolveCalls).toBe(2);
  });

  test("a close supersedes a compute already in flight rather than joining it", async () => {
    const { state, observer } = fakeSources();
    // A pre-close compute (a HEAD-advance recompute, a row mounting) parks in
    // its `compareToHead` spawn.
    const parked = deferred<Staleness>();
    state.compare = parked;
    const stale = observer.get(PAIR);
    // Let it reach `compareToHead` — its observedAt and resolve are pre-close.
    await Bun.sleep(0);
    expect(state.resolveCalls).toBe(1);

    // The run closes and the pointer now refuses; the post-close read must
    // observe that, not the parked flight's pre-close value.
    const closedAt = new Date();
    state.resolution = REFUSED;
    observer.noteClosed(PAIR);
    const fresh = await observer.get(PAIR);

    expect(state.resolveCalls).toBe(2);
    expect(fresh.resolution.ok).toBe(false);
    expect(fresh.observedAt.getTime()).toBeGreaterThanOrEqual(
      closedAt.getTime(),
    );

    // The superseded flight still settles for its own caller…
    parked.resolve(CURRENT);
    const old = await stale;
    expect(old.resolution.ok).toBe(true);
    // …and never becomes what later reads see.
    expect((await observer.get(PAIR)).resolution.ok).toBe(false);
  });
});
