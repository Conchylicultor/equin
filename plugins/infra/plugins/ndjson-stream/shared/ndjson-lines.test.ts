import { describe, expect, test } from "bun:test";
import { ndjsonFrames, NdjsonParseError } from "./ndjson-lines";

const enc = new TextEncoder();

/** A body delivering `chunks` as given (strings encoded, bytes as is), then ending. */
function body(chunks: readonly (string | Uint8Array)[]): {
  stream: ReadableStream<Uint8Array>;
  cancelled: () => unknown[];
} {
  const reasons: unknown[] = [];
  let i = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      const c = chunks[i++];
      if (c === undefined) controller.close();
      else controller.enqueue(typeof c === "string" ? enc.encode(c) : c);
    },
    cancel(reason) {
      reasons.push(reason);
    },
  });
  return { stream, cancelled: () => reasons };
}

async function collect(it: AsyncIterable<unknown>): Promise<unknown[]> {
  const out: unknown[] = [];
  for await (const v of it) out.push(v);
  return out;
}

describe("ndjsonFrames", () => {
  test("joins lines split across chunks, skips blank lines, keeps a final unterminated line", async () => {
    const { stream } = body(['{"a":', '1}\n\n{"b"', ":2}\n", '{"c":3}']);
    expect(await collect(ndjsonFrames(stream))).toEqual([
      { a: 1 },
      { b: 2 },
      { c: 3 },
    ]);
  });

  test("joins a multi-byte character split across chunks", async () => {
    const bytes = enc.encode('{"s":"é"}\n');
    const cut = bytes.indexOf(0xc3) + 1;
    const { stream } = body([bytes.slice(0, cut), bytes.slice(cut)]);
    expect(await collect(ndjsonFrames(stream))).toEqual([{ s: "é" }]);
  });

  test("a malformed line throws, naming it, and cancels the body", async () => {
    // More chunks behind the bad one, so the body is still open to cancel.
    const { stream, cancelled } = body([
      '{"a":1}\nnot json\n',
      '{"b":2}\n',
      '{"c":3}\n',
    ]);
    const seen: unknown[] = [];
    let thrown: unknown;
    try {
      for await (const v of ndjsonFrames(stream)) seen.push(v);
    } catch (err) {
      thrown = err;
    }
    expect(seen).toEqual([{ a: 1 }]);
    expect(thrown).toBeInstanceOf(NdjsonParseError);
    expect((thrown as NdjsonParseError).line).toBe("not json");
    expect(cancelled()).toHaveLength(1);
  });

  test("breaking out of the loop cancels the body", async () => {
    const { stream, cancelled } = body(['{"a":1}\n', '{"b":2}\n']);
    for await (const _ of ndjsonFrames(stream)) break;
    expect(cancelled()).toHaveLength(1);
  });

  test("aborting the signal cancels a pending read and throws its reason", async () => {
    const reasons: unknown[] = [];
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        controller = c;
      },
      cancel(reason) {
        reasons.push(reason);
      },
    });
    const ac = new AbortController();
    const it = ndjsonFrames(stream, ac.signal);
    controller.enqueue(enc.encode('{"a":1}\n'));
    expect(await it.next()).toEqual({ done: false, value: { a: 1 } });
    const pending = it.next();
    const reason = new Error("stop");
    ac.abort(reason);
    expect(pending).rejects.toBe(reason);
    expect(reasons).toEqual([reason]);
  });

  test("an already-aborted signal throws before reading", () => {
    const { stream } = body(['{"a":1}\n']);
    const ac = new AbortController();
    ac.abort(new Error("early"));
    expect(collect(ndjsonFrames(stream, ac.signal))).rejects.toThrow("early");
  });
});
