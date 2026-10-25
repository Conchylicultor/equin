/**
 * `op:"sub-batch"` + per-tab sub bookkeeping — one frame replays a tab's WHOLE
 * sub set, and the server's per-socket sub set is tagged by holding tab. Run
 * with `bun test plugins/framework/plugins/resource-runtime/core/runtime-sub-batch.test.ts`.
 *
 * Pins:
 *   - a mixed batch answers all already-current entries in ONE
 *     `up-to-date-batch` frame and serves the rest as individual sub-acks;
 *   - registration happens BEFORE the `complete: true` reconciliation, so an
 *     identical replay never transits a sub 1→0→1 (no lifecycle-hook churn),
 *     while genuinely-dropped subs ARE released;
 *   - two tabs behind one socket are isolated: a tab's departure releases only
 *     its own subs, and the socket-level refcount survives while any tab holds;
 *   - legacy untagged frames land in the `""` bucket and release on socket
 *     close (the pre-tab behavior, unchanged).
 */

import { test, expect, describe, mock } from "bun:test";
import { z } from "zod";
import { createHarness, tick } from "./test-support";

describe("sub-batch — whole-set replay for one tab", () => {
  test("mixed batch: one up-to-date-batch for the current entries, individual sub-acks for the rest", async () => {
    const h = createHarness();
    const loadsByKey: Record<string, number> = { a: 0, b: 0, c: 0 };
    for (const key of ["a", "b", "c"]) {
      h.runtime.defineExternalResource({
        key,
        mode: "push",
        schema: z.string(),
        loader: async () => {
          loadsByKey[key]!++;
          return `${key}-val`;
        },
      });
    }

    // Prime a + b on the tab (learning the epoch and each sub-ack's version);
    // c stays never-subscribed.
    await h.subscribeBatch([{ key: "a" }, { key: "b" }], { tabId: "t1" });
    const primed = h.frames.filter((f) => f.kind === "sub-ack");
    expect(primed).toHaveLength(2);
    const epoch = primed[0]!.epoch!;
    const versionOf = (key: string) =>
      primed.find((f) => f.key === key)!.version!;
    h.frames.length = 0;

    // Replay: a + b echo their current version → batched up-to-date; c is new
    // (no version) → an individual full sub-ack.
    await h.subscribeBatch(
      [
        { key: "a", version: versionOf("a") },
        { key: "b", version: versionOf("b") },
        { key: "c" },
      ],
      { tabId: "t1", epoch },
    );

    const batches = h.frames.filter((f) => f.kind === "up-to-date-batch");
    expect(batches).toHaveLength(1); // ONE frame for both current entries
    expect(batches[0]!.epoch).toBe(epoch);
    expect(batches[0]!.entries!.map((e) => e.key).sort()).toEqual(["a", "b"]);
    for (const e of batches[0]!.entries!)
      expect(e.version).toBe(versionOf(e.key));

    const acks = h.frames.filter((f) => f.kind === "sub-ack");
    expect(acks).toHaveLength(1);
    expect(acks[0]!.key).toBe("c");
    expect(loadsByKey).toEqual({ a: 1, b: 1, c: 1 }); // no re-loads for a/b
  });

  test("complete:true reconciles: identical replay fires NO lifecycle hooks; a dropped sub IS released", async () => {
    const first = mock((_p: unknown) => {});
    const last = mock((_p: unknown) => {});
    const h = createHarness();
    for (const key of ["k1", "k2"]) {
      h.runtime.defineExternalResource({
        key,
        mode: "push",
        schema: z.string(),
        loader: async () => "v",
        onFirstSubscribe: first,
        onLastUnsubscribe: last,
      });
    }

    await h.subscribeBatch([{ key: "k1" }, { key: "k2" }], { tabId: "t1" });
    expect(first).toHaveBeenCalledTimes(2); // the genuine 0→1s
    expect(last).toHaveBeenCalledTimes(0);
    const acks = h.frames.filter((f) => f.kind === "sub-ack");
    const epoch = acks[0]!.epoch!;
    const versionOf = (key: string) =>
      acks.find((f) => f.key === key)!.version!;

    // Identical replay: registration precedes reconciliation, so nothing ever
    // dips to 0 — no hook churn, no keyed-snapshot eviction, no re-loads (both
    // entries keep their tracking span, so their echoes short-circuit).
    await h.subscribeBatch(
      [
        { key: "k1", version: versionOf("k1") },
        { key: "k2", version: versionOf("k2") },
      ],
      { tabId: "t1", epoch },
    );
    expect(first).toHaveBeenCalledTimes(2); // unchanged
    expect(last).toHaveBeenCalledTimes(0); // never a 1→0→1 transit
    expect(h.frames.filter((f) => f.kind === "sub-ack")).toHaveLength(2); // no re-loads

    // A replay that DROPS k2 releases it (the tab no longer wants it).
    await h.subscribeBatch([{ key: "k1", version: versionOf("k1") }], {
      tabId: "t1",
      epoch,
    });
    expect(last).toHaveBeenCalledTimes(1);
    expect(last.mock.calls[0]![0]).toEqual({});
    expect(first).toHaveBeenCalledTimes(2); // k1 stayed up the whole time
  });

  test("two tabs on one socket are isolated: one tab's departure never releases the other's subs", async () => {
    let n = 0; // a new value on every recompute (an equal one ships nothing)
    const first = mock((_p: unknown) => {});
    const last = mock((_p: unknown) => {});
    const h = createHarness();
    const r = h.runtime.defineExternalResource({
      key: "k",
      mode: "push",
      schema: z.string(),
      loader: async () => `v${++n}`,
      onFirstSubscribe: first,
      onLastUnsubscribe: last,
    });

    // Both tabs hold k through the SAME socket. The socket-level refcount bumps
    // once (frames are per-socket), and the 0→1 hook fires once.
    await h.subscribe("k", {}, { tabId: "tA" });
    await h.subscribe("k", {}, { tabId: "tB" });
    expect(first).toHaveBeenCalledTimes(1);
    expect(h.frames.filter((f) => f.kind === "sub-ack")).toHaveLength(2);

    // Tab A departs: k survives (B still holds it) — pushes keep flowing.
    await h.unsubTab("tA");
    expect(last).toHaveBeenCalledTimes(0);
    r.notify();
    await tick();
    expect(h.pushesFor("k")).toHaveLength(1); // still delivered for B

    // Tab B departs too: NOW the socket-level sub releases.
    await h.unsubTab("tB");
    expect(last).toHaveBeenCalledTimes(1);
    r.notify();
    await tick();
    expect(h.pushesFor("k")).toHaveLength(1); // no new frame — nobody holds k
  });

  test("a per-tab unsub releases only that tab's hold; legacy untagged subs release on socket close", async () => {
    const last = mock((_p: unknown) => {});
    const h = createHarness();
    h.runtime.defineExternalResource({
      key: "k",
      mode: "push",
      schema: z.string(),
      loader: async () => "v",
      onLastUnsubscribe: last,
    });

    // A tagged and a legacy untagged sub share the pk on this socket.
    await h.subscribe("k", {}, { tabId: "tA" });
    await h.subscribe("k"); // untagged → the "" bucket
    // The tagged tab's unsub releases only its own hold; "" keeps the sub live.
    await h.unsub("k", {}, { tabId: "tA" });
    expect(last).toHaveBeenCalledTimes(0);

    // The legacy bucket's only teardown path is the socket close — which
    // releases the (key, pk) exactly once.
    h.closeSocket();
    expect(last).toHaveBeenCalledTimes(1);
  });
});
