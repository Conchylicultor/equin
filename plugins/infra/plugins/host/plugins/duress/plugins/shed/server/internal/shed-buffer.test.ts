import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearDuress,
  setDuress,
} from "@plugins/infra/plugins/host/plugins/duress/plugins/latch/server";
import {
  _setClockForTests,
  _setLatchDirForTests,
} from "@plugins/infra/plugins/host/plugins/duress/plugins/latch/server/testing";
import {
  _setFlushTimerForTests,
  _setShedConfigForTests,
  createShedBuffer,
  type ShedConfigValues,
  type ShedSummary,
} from "./shed-buffer";
import {
  type AppPath,
  asAppPath,
} from "@plugins/infra/plugins/host-fs/plugins/user-path/core";

interface Item {
  key: string;
  n: number;
}

const cfg = (over: Partial<ShedConfigValues> = {}): ShedConfigValues => ({
  enabled: true,
  persistFirstN: 3,
  bufferMaxEntries: 2000,
  bufferMaxBytes: 4_194_304,
  flushDelayMs: 30_000,
  ...over,
});

let dir: AppPath;
let t: number;
// Captured one-shot flush callbacks + the delays they were armed with.
let armedFlushes: (() => Promise<void>)[] = [];
let armedDelays: number[] = [];

beforeEach(() => {
  dir = asAppPath(mkdtempSync(join(tmpdir(), "duress-shed-")));
  _setLatchDirForTests(dir);
  t = Date.now();
  _setClockForTests(() => t);
  _setShedConfigForTests(cfg());
  armedFlushes = [];
  armedDelays = [];
  _setFlushTimerForTests({
    set: (fn, delayMs) => {
      armedFlushes.push(fn);
      armedDelays.push(delayMs);
    },
  });
});

afterEach(() => {
  _setLatchDirForTests(null);
  _setClockForTests(null);
  _setShedConfigForTests(null);
  _setFlushTimerForTests(null);
  rmSync(dir, { recursive: true, force: true });
});

function makeBuffer(replay?: (items: Item[]) => Promise<void>) {
  const replayedChunks: Item[][] = [];
  const summaries: ShedSummary[] = [];
  const buffer = createShedBuffer<Item>({
    kind: "test",
    cascadeKeyOf: (item) => item.key,
    replay:
      replay ??
      (async (items) => {
        replayedChunks.push(items);
      }),
    onFlushSummary: (summary) => summaries.push(summary),
  });
  return { buffer, replayedChunks, summaries };
}

// Latch mutations use the overridden clock for setAt and the lease's mtime;
// advancing t by small deltas keeps the lease fresh while giving each episode
// a distinct setAt.
async function startEpisode(reason: string): Promise<void> {
  t += 10;
  await setDuress(reason);
}

describe("admit outside duress", () => {
  test("always persists and never arms a flush when nothing is owed", async () => {
    const { buffer } = makeBuffer();
    for (let i = 0; i < 10; i++) {
      expect(buffer.admit({ key: "a", n: i }).persist).toBe(true);
    }
    expect(armedFlushes.length).toBe(0);
  });

  test("disabled config → persists even under duress", async () => {
    _setShedConfigForTests(cfg({ enabled: false }));
    const { buffer } = makeBuffer();
    await startEpisode("storm");
    for (let i = 0; i < 10; i++) {
      expect(buffer.admit({ key: "a", n: i }).persist).toBe(true);
    }
  });
});

describe("first-N per cascade key", () => {
  test("first N persist, the tail buffers; keys count independently", async () => {
    const { buffer } = makeBuffer();
    await startEpisode("storm");
    const a = Array.from(
      { length: 5 },
      (_, n) => buffer.admit({ key: "a", n }).persist,
    );
    expect(a).toEqual([true, true, true, false, false]);
    const b = Array.from(
      { length: 3 },
      (_, n) => buffer.admit({ key: "b", n }).persist,
    );
    expect(b).toEqual([true, true, true]);
  });

  test("a new episode (setAt change) re-grants first-N; earlier buffered items stay owed", async () => {
    const { buffer, replayedChunks, summaries } = makeBuffer();
    await startEpisode("one");
    for (let n = 0; n < 4; n++) buffer.admit({ key: "a", n }); // 3 persist, 1 buffered

    await startEpisode("two"); // distinct setAt → counters reset
    const again = Array.from(
      { length: 4 },
      (_, n) => buffer.admit({ key: "a", n: 10 + n }).persist,
    );
    expect(again).toEqual([true, true, true, false]);

    t += 10;
    await clearDuress();
    buffer.admit({ key: "a", n: 99 }); // observes the clear → arms the one-shot
    expect(armedFlushes.length).toBe(1);
    await armedFlushes[0]!();

    // Both episodes' buffered items flush together.
    expect(replayedChunks.flat().map((i) => i.n)).toEqual([3, 13]);
    expect(summaries.length).toBe(1);
    expect(summaries[0]!.byCascade["a"]).toEqual({ shed: 2, dropped: 0 });
    expect(summaries[0]!.replayed).toBe(2);
    expect(summaries[0]!.replayErrors).toBe(0);
  });
});

describe("buffer bounds", () => {
  test("entry cap drops the newest incoming and keeps the drop count", async () => {
    _setShedConfigForTests(cfg({ persistFirstN: 0, bufferMaxEntries: 2 }));
    const { buffer, replayedChunks, summaries } = makeBuffer();
    await startEpisode("storm");
    for (let n = 0; n < 5; n++) {
      expect(buffer.admit({ key: "a", n }).persist).toBe(false);
    }
    t += 10;
    await clearDuress();
    buffer.admit({ key: "a", n: 99 });
    await armedFlushes[0]!();

    expect(replayedChunks.flat().map((i) => i.n)).toEqual([0, 1]); // oldest kept
    expect(summaries[0]!.byCascade["a"]).toEqual({ shed: 2, dropped: 3 });
  });

  test("byte cap (JSON.stringify estimate) drops the newest incoming", async () => {
    const oneItemBytes = JSON.stringify({ key: "a", n: 0 }).length;
    _setShedConfigForTests(
      cfg({ persistFirstN: 0, bufferMaxBytes: oneItemBytes }),
    );
    const { buffer, replayedChunks, summaries } = makeBuffer();
    await startEpisode("storm");
    buffer.admit({ key: "a", n: 0 });
    buffer.admit({ key: "a", n: 1 });
    t += 10;
    await clearDuress();
    buffer.admit({ key: "a", n: 99 });
    await armedFlushes[0]!();

    expect(replayedChunks.flat().map((i) => i.n)).toEqual([0]);
    expect(summaries[0]!.byCascade["a"]).toEqual({ shed: 1, dropped: 1 });
  });

  test("drop-only accounting still flushes a summary (no surviving items)", async () => {
    _setShedConfigForTests(cfg({ persistFirstN: 0, bufferMaxEntries: 0 }));
    const { buffer, replayedChunks, summaries } = makeBuffer();
    await startEpisode("storm");
    for (let n = 0; n < 5; n++) buffer.admit({ key: "a", n });
    t += 10;
    await clearDuress();
    buffer.admit({ key: "a", n: 99 });
    expect(armedFlushes.length).toBe(1);
    await armedFlushes[0]!();

    expect(replayedChunks.length).toBe(0);
    expect(summaries[0]!.byCascade["a"]).toEqual({ shed: 0, dropped: 5 });
    expect(summaries[0]!.replayed).toBe(0);
  });
});

describe("flush", () => {
  test("replays in bounded chunks with a correct summary", async () => {
    _setShedConfigForTests(cfg({ persistFirstN: 0 }));
    const { buffer, replayedChunks, summaries } = makeBuffer();
    await startEpisode("storm");
    for (let n = 0; n < 250; n++) buffer.admit({ key: "a", n });
    t += 10;
    await clearDuress();
    buffer.admit({ key: "a", n: 999 });
    expect(armedDelays[0]).toBe(30_000);
    await armedFlushes[0]!();

    expect(replayedChunks.map((c) => c.length)).toEqual([100, 100, 50]);
    expect(summaries[0]!.replayed).toBe(250);
    expect(summaries[0]!.byCascade["a"]!.shed).toBe(250);
  });

  test("the one-shot arms once — a second clear-observing admit does not double-arm", async () => {
    _setShedConfigForTests(cfg({ persistFirstN: 0 }));
    const { buffer } = makeBuffer();
    await startEpisode("storm");
    buffer.admit({ key: "a", n: 0 });
    t += 10;
    await clearDuress();
    buffer.admit({ key: "a", n: 1 });
    buffer.admit({ key: "a", n: 2 });
    expect(armedFlushes.length).toBe(1);
  });

  test("a timer firing mid-episode declines; the next clear re-arms and flushes everything", async () => {
    _setShedConfigForTests(cfg({ persistFirstN: 0 }));
    const { buffer, replayedChunks, summaries } = makeBuffer();
    await startEpisode("one");
    buffer.admit({ key: "a", n: 0 });
    t += 10;
    await clearDuress();
    buffer.admit({ key: "a", n: 1 }); // arms (and persists)

    await startEpisode("two"); // re-trip before the one-shot fires
    await armedFlushes[0]!(); // fires mid-episode → must not flush
    expect(replayedChunks.length).toBe(0);

    buffer.admit({ key: "a", n: 2 }); // buffered under episode two
    t += 10;
    await clearDuress();
    buffer.admit({ key: "a", n: 3 }); // re-arms
    expect(armedFlushes.length).toBe(2);
    await armedFlushes[1]!();

    expect(replayedChunks.flat().map((i) => i.n)).toEqual([0, 2]);
    expect(summaries[0]!.byCascade["a"]!.shed).toBe(2);
  });

  test("a throwing replay chunk is counted and logged, remaining chunks still replay", async () => {
    _setShedConfigForTests(cfg({ persistFirstN: 0 }));
    const replayedChunks: Item[][] = [];
    const summaries: ShedSummary[] = [];
    const buffer = createShedBuffer<Item>({
      kind: "test",
      cascadeKeyOf: (item) => item.key,
      replay: async (items) => {
        if (items[0]!.n === 0) throw new Error("db unavailable");
        replayedChunks.push(items);
      },
      onFlushSummary: (summary) => summaries.push(summary),
    });
    await startEpisode("storm");
    for (let n = 0; n < 150; n++) buffer.admit({ key: "a", n });
    t += 10;
    await clearDuress();
    buffer.admit({ key: "a", n: 999 });
    await armedFlushes[0]!(); // resolves — never rejects

    expect(replayedChunks.map((c) => c.length)).toEqual([50]);
    expect(summaries[0]!.replayErrors).toBe(100);
    expect(summaries[0]!.replayed).toBe(50);
  });

  test("a throwing onFlushSummary does not reject the flush", async () => {
    _setShedConfigForTests(cfg({ persistFirstN: 0 }));
    const buffer = createShedBuffer<Item>({
      kind: "test",
      cascadeKeyOf: (item) => item.key,
      replay: async () => {},
      onFlushSummary: () => {
        throw new Error("consumer bug");
      },
    });
    await startEpisode("storm");
    buffer.admit({ key: "a", n: 0 });
    t += 10;
    await clearDuress();
    buffer.admit({ key: "a", n: 1 });
    await armedFlushes[0]!(); // would reject the test if the throw propagated
  });
});
