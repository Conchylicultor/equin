/**
 * One socket, many tabs: a sub the socket's own frames already answered gets
 * `up-to-date`, not its own copy of the value (`alreadyShipped`). Every tab on
 * a socket receives every frame, so after a restart, when every tab replays
 * the same tuples at once and the reads join one flight, the first tab's full
 * sub-ack is every tab's — the rest used to receive N identical copies (one
 * 2026-11-04 restart: ~7.6 MB per tab, six tabs, ~45 MB through one socket).
 *
 * Pins:
 *   - N tabs replaying one tuple on one socket: ONE value sub-ack, the other
 *     tabs answered `up-to-date` at its version — and one load;
 *   - a value frame sent BEFORE a sub arrived never answers it (the tab may
 *     have registered after that frame reached it): a later tab's sub gets
 *     the whole value;
 *   - another socket gets its own copy;
 *   - a push that already carried a newer value answers a parked sub-ack;
 *   - `_debug` counts the shared answers and the value sub-acks' chars.
 */

import { describe, expect, test } from "bun:test";
import { z } from "zod";
import {
  controllable,
  createHarness,
  type RecordedFrame,
  tick,
} from "./test-support";

const BIG = "x".repeat(10_000);

function setup(sockets = 1) {
  const h = createHarness({ sockets });
  const src = controllable(BIG);
  let loads = 0;
  const resource = h.runtime.defineExternalResource({
    key: "big",
    mode: "push",
    schema: z.string(),
    loader: async () => {
      loads++;
      return await src.loader();
    },
  });
  return { h, src, resource, loads: () => loads };
}

const valueAcks = (frames: readonly RecordedFrame[]) =>
  frames.filter((f) => f.kind === "sub-ack" && "value" in f);

describe("shared socket — one value frame answers every tab on it", () => {
  test("a replay herd of three tabs on one socket: one value sub-ack, two up-to-date", async () => {
    const { h, src, loads } = setup();
    src.block();
    // Three tabs restate the tuple at once (a restart's replay): every batch
    // arrives before the shared read settles.
    const replays = ["t1", "t2", "t3"].map((tabId) =>
      h.subscribeBatch([{ key: "big" }], { tabId }),
    );
    src.release();
    await Promise.all(replays);
    await tick();

    const acks = valueAcks(h.frames);
    expect(acks).toHaveLength(1);
    const version = acks[0]!.version;
    const shared = h.frames.filter((f) => f.kind === "up-to-date");
    expect(shared.map((f) => f.tabId).sort()).toEqual(
      ["t1", "t2", "t3"].filter((t) => t !== acks[0]!.tabId).sort(),
    );
    for (const f of shared) expect(f.version).toBe(version);
    expect(loads()).toBe(1);

    const res = await h.runtime.handleResourceHttp(
      new Request("http://localhost/api/resources/_debug"),
      { key: "_debug" },
    );
    const body = (await res.json()) as {
      resources: { key: string; subAcksShared: number; subAckChars: number }[];
    };
    const debug = body.resources.find((r) => r.key === "big")!;
    expect(debug.subAcksShared).toBe(2);
    expect(debug.subAckChars).toBeGreaterThan(BIG.length);
    expect(debug.subAckChars).toBeLessThan(2 * BIG.length);
  });

  test("a value frame sent before the sub arrived does not answer it", async () => {
    const { h } = setup();
    await h.subscribe("big", {}, { tabId: "t1" });
    // t2 mounts later: t1's sub-ack may have reached t2 before t2 held the
    // tuple, so t2 is sent the value itself.
    await h.subscribe("big", {}, { tabId: "t2" });
    await tick();
    const acks = valueAcks(h.frames);
    expect(acks.map((f) => f.tabId)).toEqual(["t1", "t2"]);
    expect(h.frames.some((f) => f.kind === "up-to-date")).toBe(false);
  });

  test("another socket gets its own copy", async () => {
    const { h, src } = setup(2);
    src.block();
    const a = h.subscribe("big", {}, { tabId: "t1", socket: 0 });
    const b = h.subscribe("big", {}, { tabId: "t2", socket: 1 });
    src.release();
    await Promise.all([a, b]);
    await tick();
    expect(valueAcks(h.framesFor(0))).toHaveLength(1);
    expect(valueAcks(h.framesFor(1))).toHaveLength(1);
    expect(h.frames.some((f) => f.kind === "up-to-date")).toBe(false);
  });

  test("a push that carried a newer value since the sub arrived answers it", async () => {
    const { h, src, resource } = setup();
    await h.subscribe("big", {}, { tabId: "t1" });
    // t2 subscribes while its read is parked; meanwhile a change pushes the
    // whole value to the socket (t1 holds the tuple), which t2 receives too.
    src.block();
    const t2 = h.subscribe("big", {}, { tabId: "t2" });
    src.setValue(`${BIG}!`);
    resource.notify();
    src.release();
    await t2;
    await tick();
    await tick();
    const update = h.frames.find((f) => f.kind === "update");
    expect(update).toBeDefined();
    const answer = h.frames.filter(
      (f) =>
        (f.kind === "sub-ack" || f.kind === "up-to-date") && f.tabId === "t2",
    );
    expect(answer).toHaveLength(1);
    expect(answer[0]!.kind).toBe("up-to-date");
    expect(answer[0]!.version).toBe(update!.version);
  });
});

// A socket whose peer routes addressed frames (the tabs' SharedWorker, after
// `op: "address-frames"`) gets each frame addressed to the tabs it is for, so
// a tab never receives — let alone parses — a frame for another tab's sub.
describe("addressed frames — each frame reaches only the tabs it is for", () => {
  const tabsOf = (f: RecordedFrame) =>
    f.to === null ? null : [...f.to!].sort();

  test("a socket that did not ask gets bare frames", async () => {
    const { h } = setup();
    await h.subscribe("big", {}, { tabId: "t1" });
    expect(h.frames.map((f) => f.to)).toEqual([null]);
  });

  test("a push reaches every tab holding the tuple, and no other", async () => {
    const { h, src, resource } = setup();
    h.runtime.defineExternalResource({
      key: "other",
      mode: "push",
      schema: z.string(),
      loader: () => Promise.resolve("o"),
    });
    h.addressFrames();
    await h.subscribe("big", {}, { tabId: "t1" });
    await h.subscribe("big", {}, { tabId: "t2" });
    await h.subscribe("other", {}, { tabId: "t3" });
    src.setValue(`${BIG}!`);
    resource.notify();
    await tick();
    await tick();
    const update = h.frames.find((f) => f.kind === "update")!;
    expect(tabsOf(update)).toEqual(["t1", "t2"]);
    const other = h.frames.find((f) => f.key === "other")!;
    expect(tabsOf(other)).toEqual(["t3"]);
  });

  test("an answer goes to its asker alone — not to a holder that already has the value", async () => {
    const { h } = setup();
    h.addressFrames();
    await h.subscribe("big", {}, { tabId: "t1" });
    await h.subscribe("big", {}, { tabId: "t2" });
    await tick();
    const acks = valueAcks(h.frames);
    expect(acks.map((f) => [f.tabId, tabsOf(f)])).toEqual([
      ["t1", ["t1"]],
      ["t2", ["t2"]],
    ]);
  });

  test("a replay herd shares one value sub-ack: it reaches every tab awaiting its answer, the rest get up-to-date", async () => {
    const { h, src, loads } = setup();
    h.addressFrames();
    src.block();
    const replays = ["t1", "t2", "t3"].map((tabId) =>
      h.subscribeBatch([{ key: "big" }], { tabId }),
    );
    src.release();
    await Promise.all(replays);
    await tick();
    const acks = valueAcks(h.frames);
    expect(acks).toHaveLength(1);
    expect(tabsOf(acks[0]!)).toEqual(["t1", "t2", "t3"]);
    const shared = h.frames.filter((f) => f.kind === "up-to-date");
    expect(shared).toHaveLength(2);
    for (const f of shared) expect(tabsOf(f)).toEqual([f.tabId!]);
    expect(loads()).toBe(1);
  });

  test("a value addressed to one tab never answers another's sub as already shipped", async () => {
    const { h, src } = setup();
    h.addressFrames();
    await h.subscribe("big", {}, { tabId: "t1" });
    // t1's value went to t1 alone; t2 is answered with its own. Then t3
    // subscribes: no value addressed to it was sent since it registered, so
    // it is sent its own — never `up-to-date` off a value it never got.
    src.block();
    const t2 = h.subscribe("big", {}, { tabId: "t2" });
    src.release();
    await t2;
    await tick();
    await h.subscribe("big", {}, { tabId: "t3" });
    await tick();
    const t3 = h.frames.filter(
      (f) =>
        (f.kind === "sub-ack" || f.kind === "up-to-date") && f.tabId === "t3",
    );
    expect(t3.map((f) => f.kind)).toEqual(["sub-ack"]);
    expect(tabsOf(t3[0]!)).toEqual(["t3"]);
  });

  test("a frame an untagged (legacy) holder holds goes out bare", async () => {
    const { h, src, resource } = setup();
    h.addressFrames();
    await h.subscribe("big", {}); // no tabId
    src.setValue(`${BIG}?`);
    resource.notify();
    await tick();
    await tick();
    for (const f of h.frames) expect(f.to).toBeNull();
  });
});
