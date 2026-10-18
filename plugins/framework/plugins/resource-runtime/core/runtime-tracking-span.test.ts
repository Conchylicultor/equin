/**
 * Tracking spans — why a version short-circuit can trust a version.
 *
 * A tuple is TRACKED only while it has a subscriber: the change feed routes a
 * change to subscribed tuples (a param'd tuple with none admits nothing), and a
 * `whileSubscribed` / `onFirstSubscribe` watcher stops at the last unsubscribe.
 * So the version counter is a complete change signal only within one span of
 * continuous subscription. Every span therefore opens with a fresh version
 * (`registerSubOnSocket`, on the global 0→1): a version minted before it — last
 * acked to a tab before its socket dropped, or read over HTTP while nobody
 * subscribed — can never match again, and the replay takes the full path.
 *
 * Each case below is a way the old short-circuit answered `up-to-date` over a
 * change nothing tracked. The same-socket replay (the missed-update probe, the
 * chronic replay the short-circuit exists for) keeps its span and still
 * short-circuits.
 */

import { describe, expect, test } from "bun:test";
import { z } from "zod";
import {
  createHarness,
  tick,
  type Harness,
  type RecordedFrame,
} from "./test-support";
import { feedChange, wholeReach } from "./testing/routed-fixture";

/** A param'd push value reading table `t` whole (a reach plan). */
function defineDbp(h: Harness, loader: () => string): void {
  h.runtime.defineResource(
    { key: "dbp", schema: z.string(), validateParams: () => {} },
    { mode: "push", reach: wholeReach(["t"]), loader },
  );
}

/** The answer socket `i` got to its latest (re)subscription of `key`. */
function answerOn(
  frames: RecordedFrame[],
  socket: number,
  key: string,
): { kind: string; value?: unknown; version?: number } {
  const answers = frames.filter(
    (f) =>
      f.socket === socket &&
      (((f.kind === "sub-ack" || f.kind === "up-to-date") && f.key === key) ||
        (f.kind === "up-to-date-batch" &&
          (f.entries as { key: string }[]).some((e) => e.key === key))),
  );
  const last = answers.at(-1);
  if (last === undefined) throw new Error(`no answer for ${key} on ${socket}`);
  return last as { kind: string; value?: unknown; version?: number };
}

describe("a replay after a tracking gap is never up-to-date", () => {
  test("an external value whose watcher runs only while subscribed", async () => {
    const h = createHarness({ sockets: 2 });
    let truth = "v1";
    let watcher: (() => void) | undefined;
    const r = h.runtime.defineExternalResource({
      key: "ext",
      mode: "push",
      schema: z.string(),
      loader: () => truth,
      onFirstSubscribe: () => {
        watcher = () => r.notify();
      },
      onLastUnsubscribe: () => {
        watcher = undefined;
      },
    });
    await h.subscribe("ext", {}, { socket: 0 });
    const ack = answerOn(h.frames, 0, "ext") as { version: number };
    const { epoch } = h.frames.find((f) => f.kind === "sub-ack")!;

    h.closeSocket(0); // the last subscriber leaves: the watcher stops
    truth = "v2";
    watcher?.(); // nobody watches: no notify
    await tick();

    await h.subscribeBatch([{ key: "ext", version: ack.version }], {
      socket: 1,
      epoch,
    });
    expect(answerOn(h.frames, 1, "ext")).toMatchObject({
      kind: "sub-ack",
      value: "v2",
    });
  });

  test("a param'd DB-backed tuple the change feed did not route to", async () => {
    const h = createHarness({ sockets: 2 });
    let truth = "v1";
    defineDbp(h, () => truth);
    await h.subscribe("dbp", { id: "a" }, { socket: 0 });
    const ack = h.frames.find((f) => f.kind === "sub-ack")!;

    h.closeSocket(0);
    truth = "v2";
    feedChange(h, { table: "t", op: "U", ids: null });
    await tick();
    await tick();

    await h.subscribeBatch(
      [{ key: "dbp", params: { id: "a" }, version: ack.version }],
      { socket: 1, epoch: ack.epoch },
    );
    expect(answerOn(h.frames, 1, "dbp")).toMatchObject({
      kind: "sub-ack",
      value: "v2",
    });
  });

  test("another socket resubscribed in between: its fresh load does not vouch for the old version", async () => {
    const h = createHarness({ sockets: 3 });
    let truth = "v1";
    defineDbp(h, () => truth);
    await h.subscribe("dbp", { id: "a" }, { socket: 0 });
    const ack = h.frames.find((f) => f.kind === "sub-ack")!;

    h.closeSocket(0);
    truth = "v2"; // untracked: no subscriber
    await h.subscribe("dbp", { id: "a" }, { socket: 1 }); // B loads v2
    expect(answerOn(h.frames, 1, "dbp")).toMatchObject({ value: "v2" });

    // A's tab reconnects on C, echoing the version it held with v1 — not first
    // any more (B holds the tuple), but the version names another span.
    await h.subscribeBatch(
      [{ key: "dbp", params: { id: "a" }, version: ack.version }],
      { socket: 2, epoch: ack.epoch },
    );
    expect(answerOn(h.frames, 2, "dbp")).toMatchObject({
      kind: "sub-ack",
      value: "v2",
    });
  });

  test("a version read over HTTP while nobody subscribed", async () => {
    const h = createHarness();
    let truth = "v1";
    defineDbp(h, () => truth);
    const res = await h.runtime.handleResourceHttp(
      new Request("http://localhost/api/resources/dbp?id=a"),
      { key: "dbp" },
    );
    const body = (await res.json()) as {
      value: string;
      version: number;
      epoch: string;
    };
    expect(body.value).toBe("v1");

    truth = "v2"; // untracked: no subscriber
    await h.subscribeBatch(
      [{ key: "dbp", params: { id: "a" }, version: body.version }],
      { epoch: body.epoch },
    );
    expect(answerOn(h.frames, 0, "dbp")).toMatchObject({
      kind: "sub-ack",
      value: "v2",
    });
  });
});

describe("within one span the short-circuit still holds", () => {
  test("a same-socket replay of a tuple it still holds is up-to-date, with no load", async () => {
    const h = createHarness();
    let loads = 0;
    defineDbp(h, () => {
        loads++;
      return "v1";
    });
    await h.subscribeBatch([{ key: "dbp", params: { id: "a" } }], {
      tabId: "t1",
    });
    const ack = answerOn(h.frames, 0, "dbp") as { version: number };
    const { epoch } = h.frames.find((f) => f.kind === "sub-ack")!;
    expect(loads).toBe(1);

    // The missed-update probe: the same tab restates its whole set on the
    // same socket — registered before reconciling, so the tuple never left.
    await h.subscribeBatch(
      [{ key: "dbp", params: { id: "a" }, version: ack.version }],
      { tabId: "t1", epoch },
    );
    expect(answerOn(h.frames, 0, "dbp").kind).toBe("up-to-date-batch");
    expect(loads).toBe(1);
  });

  test("a replay reaching the server before the old socket's close is still in the span", async () => {
    // The old socket still holds the tuple, so changes kept reaching it (and
    // its frames went to a dead socket): the version is still this span's.
    const h = createHarness({ sockets: 2 });
    defineDbp(h, () => "v1");
    await h.subscribe("dbp", { id: "a" }, { socket: 0 });
    const ack = h.frames.find((f) => f.kind === "sub-ack")!;
    await h.subscribeBatch(
      [{ key: "dbp", params: { id: "a" }, version: ack.version }],
      { socket: 1, epoch: ack.epoch },
    );
    expect(answerOn(h.frames, 1, "dbp").kind).toBe("up-to-date-batch");
    h.closeSocket(0);
  });

  test("each span's first sub-ack carries a version above every earlier one", async () => {
    const h = createHarness();
    defineDbp(h, () => "v");
    await h.subscribe("dbp", { id: "a" });
    await h.unsub("dbp", { id: "a" });
    await h.subscribe("dbp", { id: "a" });
    const versions = h.frames
      .filter((f) => f.kind === "sub-ack")
      .map((f) => f.version);
    expect(versions).toEqual([1, 2]);
  });
});
