import { describe, expect, test } from "bun:test";
import type { FileSink } from "@plugins/infra/plugins/file-sink/core";
import type { LogEntry, PublishLine } from "./registry";
import {
  MAX_HISTORY,
  createChannel,
  getOrCreateChannel,
  subscribe,
} from "./registry";

// Pure: no fs, no env, no boot graph. The registry takes its durable backing store
// as an INJECTED factory, so a stub `FileSink` is the whole test double — which is
// also what makes "one write per batch" assertable at all.
//
// The registry is process-global and `createChannel` throws on a duplicate id, so
// every test mints its own id.

interface SinkStub extends FileSink {
  /** One entry per `appendAll` call, holding that call's lines. */
  batches: string[][];
  /** Every `append` (singular) call — must stay empty on the batched path. */
  singles: string[];
}

function makeSinkStub(): SinkStub {
  const stub: SinkStub = {
    id: "stub",
    description: "stub",
    path: "/dev/null",
    bound: { kind: "rotate", maxBytes: 1, keep: 1 },
    batches: [],
    singles: [],
    append: (line) => {
      stub.singles.push(line);
    },
    appendAll: (lines) => {
      stub.batches.push([...lines]);
    },
    readTail: () => ({ kind: "missing" }),
    readJsonlTail: () => ({ kind: "missing" }),
  };
  return stub;
}

/** A durable channel plus its stub sink and a count of factory invocations. */
function durableChannel(id: string) {
  const sink = makeSinkStub();
  let made = 0;
  const channel = createChannel(id, () => {
    made += 1;
    return sink;
  });
  return { channel, sink, madeCount: () => made };
}

function batch(count: number, prefix = "line"): PublishLine[] {
  return Array.from({ length: count }, (_, i) => ({ line: `${prefix}-${i}` }));
}

describe("publishAll", () => {
  test("a 500-line batch is ONE sink write, not 500", () => {
    // The regression guard for the whole change: the ingress path used to fire
    // ~4 blocking syscalls per line on the event loop.
    const { channel, sink, madeCount } = durableChannel("t-one-write");
    channel.publishAll(batch(500));

    expect(madeCount()).toBe(1); // sink resolved lazily, exactly once
    expect(sink.batches.length).toBe(1);
    expect(sink.batches[0]?.length).toBe(500);
    expect(sink.singles).toEqual([]); // the singular path is never taken

    // The envelope the read path parses back is still minted per line.
    const first = JSON.parse(sink.batches[0]![0]!) as Record<string, unknown>;
    expect(first.line).toBe("line-0");
    expect(first.stream).toBe("stdout");
    expect(typeof first.t).toBe("number");
  });

  test("per-line WS delivery is preserved: 500 callbacks, in order, contiguous seq", () => {
    const { channel } = durableChannel("t-per-line");
    const seen: LogEntry[] = [];
    const { unsubscribe } = subscribe("t-per-line", (e) => seen.push(e));

    channel.publishAll(batch(500));
    unsubscribe();

    expect(seen.length).toBe(500);
    expect(seen.map((e) => e.line)).toEqual(batch(500).map((b) => b.line));
    expect(seen.map((e) => e.seq)).toEqual(
      Array.from({ length: 500 }, (_, i) => seen[0]!.seq + i),
    );
  });

  test("the ring trims to MAX_HISTORY and keeps the NEWEST entries", () => {
    // Batched publishes past the cap — catches a `splice` off-by-one, which a
    // per-line `shift` could not get wrong.
    const { channel } = durableChannel("t-ring-trim");
    const total = MAX_HISTORY + 1_500;
    for (let i = 0; i < total; i += 500) {
      channel.publishAll(
        Array.from({ length: 500 }, (_, k) => ({ line: `line-${i + k}` })),
      );
    }

    const { history, unsubscribe } = subscribe("t-ring-trim", () => {});
    unsubscribe();

    expect(history.length).toBe(MAX_HISTORY);
    expect(history[0]!.line).toBe(`line-${total - MAX_HISTORY}`);
    expect(history.at(-1)!.line).toBe(`line-${total - 1}`);
    // Contiguous, oldest-first, ending at the latest seq.
    expect(history.at(-1)!.seq - history[0]!.seq).toBe(MAX_HISTORY - 1);
    expect(history.at(-1)!.seq).toBe(total);
  });

  test("an empty batch touches nothing (no sink is even resolved)", () => {
    const { channel, sink, madeCount } = durableChannel("t-empty");
    channel.publishAll([]);
    expect(madeCount()).toBe(0);
    expect(sink.batches).toEqual([]);
  });
});

describe("publish", () => {
  test("delegates to publishAll: one entry, one appendAll of length 1", () => {
    const { channel, sink } = durableChannel("t-delegate");
    channel.publish("solo", "stderr", 1234);

    expect(sink.batches).toEqual([
      [JSON.stringify({ t: 1234, stream: "stderr", line: "solo" })],
    ]);
    expect(sink.singles).toEqual([]);

    const { history, unsubscribe } = subscribe("t-delegate", () => {});
    unsubscribe();
    expect(history.map((e) => [e.line, e.stream, e.timestamp])).toEqual([
      ["solo", "stderr", 1234],
    ]);
  });
});

describe("ephemeral channels", () => {
  test("Log.channel-style channels publish with no sink at all", () => {
    // `createChannel(id)` with no factory is what `Log.channel` builds.
    const channel = createChannel("t-ephemeral");
    const seen: LogEntry[] = [];
    const { unsubscribe } = subscribe("t-ephemeral", (e) => seen.push(e));

    channel.publish("a");
    channel.publishAll(batch(3));
    unsubscribe();

    expect(seen.map((e) => e.line)).toEqual([
      "a",
      "line-0",
      "line-1",
      "line-2",
    ]);
  });

  test("getOrCreateChannel hands the same underlying channel back", () => {
    const sink = makeSinkStub();
    const first = getOrCreateChannel("t-idempotent", () => sink);
    const second = getOrCreateChannel("t-idempotent", () => sink);
    first.publishAll(batch(2));
    second.publishAll(batch(2, "more"));

    // Two batches, one sink: the factory is stored on first sight, not re-run.
    expect(sink.batches.length).toBe(2);
    const { history, unsubscribe } = subscribe("t-idempotent", () => {});
    unsubscribe();
    expect(history.map((e) => e.seq)).toEqual([1, 2, 3, 4]);
  });
});
