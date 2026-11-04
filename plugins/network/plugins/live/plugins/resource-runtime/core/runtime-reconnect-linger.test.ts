/**
 * A reconnect keeps its tracking span, and a version lives exactly as long as
 * its span.
 *
 * Linger: a socket `close` is not a tab leaving (that is `unsub-tab`), so the
 * closed socket's subs stay held — every tuple stays tracked — until its tab's
 * complete replay registered on another socket, its `unsub-tab` arrives, or
 * `SOCKET_LINGER_MS` passes. A replay that echoes the current version is then
 * answered from memory; a change in the gap still moved the version, so it
 * reloads.
 *
 * Clock: every version comes from one runtime-wide clock and is deleted at the
 * tuple's N→0, so the map is bounded by the tracked tuples and no later span
 * can re-use a version an old tab holds.
 *
 * research/2026-11-04-global-live-reconnect-linger-and-version-clock.md
 */

import { describe, expect, mock, test } from "bun:test";
import { z } from "zod";
import type { LingerLedgerSnapshot } from "./linger-ledger";
import { SOCKET_LINGER_MS } from "./runtime";
import {
  createHarness,
  makeClientView,
  tick,
  type Harness,
  type RecordedFrame,
} from "./test-support";
import { withFakeClock } from "./testing/fake-clock";
import {
  defineRoutedTable,
  feedChange,
  wholeReach,
} from "./testing/routed-fixture";

const TAB = "t1";

/** A param'd push value reading table `t` whole; counts its loads. */
function defineDbp(h: Harness, read: () => string): { loads: number } {
  const counter = { loads: 0 };
  h.runtime.defineResource(
    { key: "dbp", schema: z.string(), validateParams: () => {} },
    {
      mode: "push",
      reach: wholeReach(["t"]),
      loader: () => {
        counter.loads++;
        return read();
      },
    },
  );
  return counter;
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

interface Debug {
  linger: { sockets: number; records: number } & LingerLedgerSnapshot;
  resources: Array<{
    key: string;
    versions: Record<string, number>;
    subCounts: Record<string, number>;
    subShortCircuits: number;
  }>;
}

async function debugOf(h: Harness): Promise<Debug> {
  const res = await h.runtime.handleResourceHttp(
    new Request("http://localhost/api/resources/_debug"),
    { key: "_debug" },
  );
  return (await res.json()) as Debug;
}

async function entryDebug(h: Harness, key: string) {
  const e = (await debugOf(h)).resources.find((r) => r.key === key);
  if (e === undefined) throw new Error(`no _debug entry for ${key}`);
  return e;
}

/** Subscribe `dbp {id: a}` for TAB on socket 0; its sub-ack. */
async function held(h: Harness): Promise<RecordedFrame> {
  await h.subscribeBatch([{ key: "dbp", params: { id: "a" } }], {
    tabId: TAB,
  });
  return h.frames.find((f) => f.kind === "sub-ack" && f.key === "dbp")!;
}

/** TAB's reconnect: its whole set replayed on socket 1, echoing `ack`. */
async function replay(h: Harness, ack: RecordedFrame): Promise<void> {
  await h.subscribeBatch(
    [{ key: "dbp", params: { id: "a" }, version: ack.version }],
    { socket: 1, tabId: TAB, epoch: ack.epoch },
  );
}

describe("a reconnect within the linger keeps its span", () => {
  test("nothing changed: the replay is up-to-date, with no load", async () => {
    const h = createHarness({ sockets: 2 });
    const c = defineDbp(h, () => "v1");
    const ack = await held(h);
    const loads = c.loads;

    h.closeSocket(0);
    await replay(h, ack);

    expect(answerOn(h.frames, 1, "dbp")).toMatchObject({
      kind: "up-to-date-batch",
    });
    expect(c.loads).toBe(loads);
    expect((await entryDebug(h, "dbp")).subShortCircuits).toBe(1);
    // The replay took the closed socket's hold over: nothing lingers.
    expect((await debugOf(h)).linger).toMatchObject({ sockets: 0, records: 0 });
    expect((await entryDebug(h, "dbp")).subCounts).toEqual({
      '{"id":"a"}': 1,
    });
  });

  test("a change routed in the gap: the replay reloads the new value", async () => {
    const h = createHarness({ sockets: 2 });
    let truth = "v1";
    defineDbp(h, () => truth);
    const ack = await held(h);

    h.closeSocket(0);
    truth = "v2";
    feedChange(h, { table: "t", op: "U", ids: null });
    await tick();
    await tick();
    await replay(h, ack);

    expect(answerOn(h.frames, 1, "dbp")).toMatchObject({
      kind: "sub-ack",
      value: "v2",
    });
  });

  test("a notify of every tuple in the gap reaches the lingering tuple", async () => {
    const h = createHarness({ sockets: 2 });
    let truth = "v1";
    h.runtime.defineExternalResource({
      key: "dbp",
      mode: "push",
      schema: z.string(),
      validateParams: () => {},
      loader: () => truth,
    });
    const ack = await held(h);

    h.closeSocket(0);
    truth = "v2";
    // A synthetic push of every subscribed tuple (the param-less fan-out).
    expect(h.runtime.triggerResourcePush("dbp")).toBe(1);
    await tick();
    await tick();
    await replay(h, ack);

    expect(answerOn(h.frames, 1, "dbp")).toMatchObject({
      kind: "sub-ack",
      value: "v2",
    });
  });

  test("a watcher that runs while subscribed keeps running through the gap and still notifies", async () => {
    const h = createHarness({ sockets: 2 });
    let truth = "v1";
    let watcher: (() => void) | undefined;
    const last = mock((_p: unknown) => {});
    const r = h.runtime.defineExternalResource({
      key: "dbp",
      mode: "push",
      schema: z.string(),
      validateParams: () => {},
      loader: () => truth,
      onFirstSubscribe: () => {
        watcher = () => r.notify({ id: "a" });
      },
      onLastUnsubscribe: () => {
        watcher = undefined;
        last(undefined);
      },
    });
    const ack = await held(h);

    h.closeSocket(0);
    expect(last).toHaveBeenCalledTimes(0);
    truth = "v2";
    watcher?.();
    await tick();
    await tick();
    await replay(h, ack);

    expect(answerOn(h.frames, 1, "dbp")).toMatchObject({
      kind: "sub-ack",
      value: "v2",
    });
    expect(last).toHaveBeenCalledTimes(0);
  });

  test("a replay that no longer names a tuple releases it", async () => {
    const h = createHarness({ sockets: 2 });
    const last = mock((_p: unknown) => {});
    h.runtime.defineExternalResource({
      key: "dbp",
      mode: "push",
      schema: z.string(),
      validateParams: () => {},
      loader: () => "v1",
      onLastUnsubscribe: last,
    });
    await held(h);

    h.closeSocket(0);
    await h.subscribeBatch([], { socket: 1, tabId: TAB });

    expect(last).toHaveBeenCalledTimes(1);
    expect((await debugOf(h)).linger).toMatchObject({ sockets: 0, records: 0 });
    expect((await entryDebug(h, "dbp")).versions).toEqual({});
  });

  test("the tab's unsub-tab on another socket releases its lingering subs at once", async () => {
    const h = createHarness({ sockets: 2 });
    const last = mock((_p: unknown) => {});
    h.runtime.defineExternalResource({
      key: "dbp",
      mode: "push",
      schema: z.string(),
      validateParams: () => {},
      loader: () => "v1",
      onLastUnsubscribe: last,
    });
    await held(h);

    h.closeSocket(0);
    await h.unsubTab(TAB, { socket: 1 });

    expect(last).toHaveBeenCalledTimes(1);
    expect((await debugOf(h)).linger).toMatchObject({ sockets: 0, records: 0 });
  });

  test("only the tab that replayed is released: another tab's hold lingers to the bound", async () => {
    await withFakeClock(async (clock) => {
      const h = createHarness({ sockets: 2 });
      const last = mock((_p: unknown) => {});
      h.runtime.defineExternalResource({
        key: "dbp",
        mode: "push",
        schema: z.string(),
        validateParams: () => {},
        loader: () => "v1",
        onLastUnsubscribe: last,
      });
      await held(h);
      await h.subscribeBatch([{ key: "dbp", params: { id: "b" } }], {
        tabId: "t2",
      });

      h.closeSocket(0);
      await h.subscribeBatch([{ key: "dbp", params: { id: "a" } }], {
        socket: 1,
        tabId: TAB,
      });
      expect((await debugOf(h)).linger).toMatchObject({
        sockets: 1,
        records: 1,
      });
      expect(last).toHaveBeenCalledTimes(0);

      await clock.advance(SOCKET_LINGER_MS);
      expect(last).toHaveBeenCalledTimes(1);
      expect(last.mock.calls[0]![0]).toEqual({ id: "b" });
      expect((await debugOf(h)).linger).toMatchObject({
        sockets: 0,
        records: 0,
      });
    });
  });
});

describe("a keyed tuple held only by a lingering socket", () => {
  test("a FULL change in the gap leaves no stale diff base: the replay and every later delta are right", async () => {
    const h = createHarness({ sockets: 2 });
    type Row = { id: string; n: number };
    const rows = new Map<string, Row>([
      ["a", { id: "a", n: 1 }],
      ["b", { id: "b", n: 2 }],
    ]);
    const ordered = () => [...rows.values()].sort((x, y) => x.n - y.n);
    const t = defineRoutedTable<Row>(h, {
      key: "win",
      table: "items",
      membership: "window",
      loader: (_p, ctx) =>
        ctx === undefined
          ? ordered().slice(0, 3)
          : ordered().filter((r) => ctx.affectedIds.includes(r.id)),
      windowIdsOf: async () =>
        ordered()
          .slice(0, 3)
          .map((r) => r.id),
      limitOf: () => 3,
    });
    const W = { limit: "3" };
    await h.subscribeBatch([{ key: "win", params: W }], { tabId: TAB });
    const ack = h.frames.find((f) => f.kind === "sub-ack" && f.key === "win")!;

    h.closeSocket(0);
    rows.set("y", { id: "y", n: 3 });
    t.feed("U", null); // an id-less change: the FULL drain, nobody to send to
    await tick();
    await tick();

    const at = h.frames.length;
    await h.subscribeBatch([{ key: "win", params: W, version: ack.version }], {
      socket: 1,
      tabId: TAB,
      epoch: ack.epoch,
    });
    // The new row goes again: against a stale base (one without it) the
    // delete would be "outside the snapshot" — a no-op the tab never sees.
    rows.delete("y");
    t.feed("D", ["y"]);
    await tick();
    await tick();

    const view = makeClientView();
    view.applyAll(h.frames.slice(at).filter((f) => f.socket === 1));
    expect(view.value).toEqual(ordered().slice(0, 3));
  });
});

describe("a replay that raced the old socket's close", () => {
  test("the tab's records on the closing socket are released at the close, not at the bound", async () => {
    const h = createHarness({ sockets: 2 });
    const last = mock((_p: unknown) => {});
    h.runtime.defineExternalResource({
      key: "dbp",
      mode: "push",
      schema: z.string(),
      validateParams: () => {},
      loader: () => "v1",
      onLastUnsubscribe: last,
    });
    await h.subscribeBatch(
      [
        { key: "dbp", params: { id: "a" } },
        { key: "dbp", params: { id: "b" } },
      ],
      { tabId: TAB },
    );
    // The replay lands first — and no longer names b.
    await h.subscribeBatch([{ key: "dbp", params: { id: "a" } }], {
      socket: 1,
      tabId: TAB,
    });
    h.closeSocket(0);

    expect((await debugOf(h)).linger).toMatchObject({ sockets: 0, records: 0 });
    expect(last).toHaveBeenCalledTimes(1);
    expect(last.mock.calls[0]![0]).toEqual({ id: "b" });
    expect((await entryDebug(h, "dbp")).subCounts).toEqual({
      '{"id":"a"}': 1,
    });
  });
});

describe("a tab that never comes back", () => {
  test("its tuples are released when the linger ends, and their versions with them", async () => {
    await withFakeClock(async (clock) => {
      const h = createHarness({ sockets: 2 });
      const last = mock((_p: unknown) => {});
      h.runtime.defineExternalResource({
        key: "dbp",
        mode: "push",
        schema: z.string(),
        validateParams: () => {},
        loader: () => "v1",
        onLastUnsubscribe: last,
      });
      await held(h);

      h.closeSocket(0);
      await clock.advance(SOCKET_LINGER_MS - 1);
      expect(last).toHaveBeenCalledTimes(0);
      await clock.advance(1);
      expect(last).toHaveBeenCalledTimes(1);
      const e = await entryDebug(h, "dbp");
      expect(e.subCounts).toEqual({});
      expect(e.versions).toEqual({});
    });
  });

  test("a replay after the linger ended opens a new span: it reloads", async () => {
    await withFakeClock(async (clock) => {
      const h = createHarness({ sockets: 2 });
      let truth = "v1";
      defineDbp(h, () => truth);
      const ack = await held(h);

      h.closeSocket(0);
      await clock.advance(SOCKET_LINGER_MS);
      truth = "v2"; // untracked: nothing routes it, nothing tells
      await replay(h, ack);

      expect(answerOn(h.frames, 1, "dbp")).toMatchObject({
        kind: "sub-ack",
        value: "v2",
      });
    });
  });
});

describe("one runtime-wide version clock", () => {
  test("the version map holds exactly the tracked tuples", async () => {
    const h = createHarness();
    defineDbp(h, () => "v");
    for (let i = 0; i < 20; i++) {
      await h.subscribe("dbp", { id: `x${i}` }, { tabId: TAB });
    }
    for (let i = 0; i < 15; i++) {
      await h.unsub("dbp", { id: `x${i}` }, { tabId: TAB });
    }
    const e = await entryDebug(h, "dbp");
    expect(Object.keys(e.versions).sort()).toEqual(
      Object.keys(e.subCounts).sort(),
    );
    expect(Object.keys(e.versions)).toHaveLength(5);
  });

  test("a re-subscribed tuple never re-uses a version an old tab holds", async () => {
    const h = createHarness();
    let truth = "v1";
    defineDbp(h, () => truth);
    const first = await held(h);

    await h.unsub("dbp", { id: "a" }, { tabId: TAB }); // N→0: the version dies
    truth = "v2"; // untracked
    await h.subscribeBatch(
      [{ key: "dbp", params: { id: "a" }, version: first.version }],
      { tabId: TAB, epoch: first.epoch },
    );

    const again = answerOn(h.frames, 0, "dbp");
    expect(again).toMatchObject({ kind: "sub-ack", value: "v2" });
    expect(again.version!).toBeGreaterThan(first.version!);
  });

  test("an untracked HTTP read reports a version no lower than any handed out", async () => {
    const h = createHarness();
    defineDbp(h, () => "v");
    const ack = await held(h);
    await h.unsub("dbp", { id: "a" }, { tabId: TAB });

    const res = await h.runtime.handleResourceHttp(
      new Request("http://localhost/api/resources/dbp?id=a"),
      { key: "dbp" },
    );
    const body = (await res.json()) as { version: number };
    expect(body.version).toBeGreaterThanOrEqual(ack.version!);
  });
});

describe("_debug.linger records what each linger did", () => {
  test("a replay within the bound: ended by the replay, on each clock, with the host's sleep", async () => {
    await withFakeClock(async (clock) => {
      let asleep = 1_000;
      const h = createHarness({ sockets: 2, asleepMs: () => asleep });
      defineDbp(h, () => "v1");
      const ack = await held(h);

      h.closeSocket(0);
      await clock.advance(5_000);
      asleep += 3_000;
      await replay(h, ack);

      const l = (await debugOf(h)).linger;
      expect(l.ended).toEqual({ replayed: 1, "unsub-tab": 0, expired: 0 });
      expect(l.lateReplays).toBe(0);
      expect(l.episodes).toEqual([
        {
          closedAt: expect.any(Number),
          tabs: 1,
          records: 1,
          endedBy: "replayed",
          held: { wallMs: 5_000, monoMs: 5_000, asleepMs: 3_000 },
          expiredRecords: 0,
          lateReplay: null,
        },
      ]);
    });
  });

  test("an unsub-tab ends it so", async () => {
    const h = createHarness({ sockets: 2 });
    defineDbp(h, () => "v1");
    await held(h);

    h.closeSocket(0);
    await h.unsubTab(TAB, { socket: 1 });

    const l = (await debugOf(h)).linger;
    expect(l.ended).toEqual({ replayed: 0, "unsub-tab": 1, expired: 0 });
    // No sleep clock on this host: unknown, never 0.
    expect(l.episodes[0]?.held?.asleepMs).toBeNull();
  });

  test("a tab back after the bound is a late replay, measured from the close", async () => {
    await withFakeClock(async (clock) => {
      const h = createHarness({ sockets: 2, asleepMs: () => 0 });
      defineDbp(h, () => "v1");
      const ack = await held(h);

      h.closeSocket(0);
      await clock.advance(SOCKET_LINGER_MS);
      let l = (await debugOf(h)).linger;
      expect(l.ended.expired).toBe(1);
      expect(l.episodes[0]).toMatchObject({
        endedBy: "expired",
        expiredRecords: 1,
        lateReplay: null,
      });

      await clock.advance(10_000);
      await replay(h, ack);
      l = (await debugOf(h)).linger;
      expect(l.lateReplays).toBe(1);
      expect(l.episodes[0]?.lateReplay).toEqual({
        wallMs: SOCKET_LINGER_MS + 10_000,
        monoMs: SOCKET_LINGER_MS + 10_000,
        asleepMs: 0,
      });

      // Its next reconnect is an ordinary one, not late again.
      h.closeSocket(1);
      await h.subscribeBatch([{ key: "dbp", params: { id: "a" } }], {
        socket: 0,
        tabId: TAB,
      });
      expect((await debugOf(h)).linger.lateReplays).toBe(1);
    });
  });

  test("a tab that replayed before another tab's hold expired is not awaited", async () => {
    await withFakeClock(async (clock) => {
      const h = createHarness({ sockets: 2 });
      defineDbp(h, () => "v1");
      const ack = await held(h);
      await h.subscribeBatch([{ key: "dbp", params: { id: "a" } }], {
        tabId: "t2",
      });

      h.closeSocket(0);
      await replay(h, ack);
      await clock.advance(SOCKET_LINGER_MS);
      // TAB's next reconnect, long after: it came back in time last time.
      await h.subscribeBatch([{ key: "dbp", params: { id: "a" } }], {
        socket: 1,
        tabId: TAB,
      });

      const l = (await debugOf(h)).linger;
      expect(l.ended.expired).toBe(1);
      expect(l.lateReplays).toBe(0);
    });
  });
});
