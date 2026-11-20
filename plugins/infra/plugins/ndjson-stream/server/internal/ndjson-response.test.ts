import { describe, expect, test } from "bun:test";
import { ndjsonFrames } from "../../shared/ndjson-lines";
import { ndjsonResponse } from "./ndjson-response";

async function frames(res: Response): Promise<unknown[]> {
  const out: unknown[] = [];
  for await (const f of ndjsonFrames(res.body!)) out.push(f);
  return out;
}

/** A producer that emits once, then waits for its signal and records it fired. */
function longLived() {
  const state = { aborted: false, released: false };
  let started!: () => void;
  const running = new Promise<void>((r) => {
    started = r;
  });
  const produce = async (
    emit: (frame: object) => void,
    signal: AbortSignal,
  ) => {
    emit({ hello: true });
    started();
    await new Promise<void>((resolve) =>
      signal.addEventListener("abort", () => resolve(), { once: true }),
    );
    state.aborted = true;
    emit({ dropped: true }); // no reader: a no-op, not a throw
    state.released = true;
  };
  return { state, produce, running };
}

describe("ndjsonResponse", () => {
  test("streams each frame as one line and closes", async () => {
    const res = ndjsonResponse(async (emit) => {
      emit({ a: 1 });
      await Promise.resolve();
      emit({ b: 2 });
    });
    expect(res.headers.get("Content-Type")).toBe("application/x-ndjson");
    expect(await res.text()).toBe('{"a":1}\n{"b":2}\n');
  });

  test("an unexpected throw becomes an error frame", async () => {
    const res = ndjsonResponse(async (emit) => {
      emit({ step: 1 });
      await Promise.resolve();
      throw new Error("boom");
    });
    expect(await frames(res)).toEqual([{ step: 1 }, { error: "boom" }]);
  });

  test("a cancelled stream aborts the producer's signal", async () => {
    const p = longLived();
    const res = ndjsonResponse(p.produce);
    const reader = res.body!.getReader();
    await p.running;
    await reader.read();
    await reader.cancel("client gone");
    await Promise.resolve();
    expect(p.state.aborted).toBe(true);
    expect(p.state.released).toBe(true);
  });

  test("an aborted request signal aborts the producer and ends the stream", async () => {
    const p = longLived();
    const ac = new AbortController();
    const res = ndjsonResponse(p.produce, { signal: ac.signal });
    const read = frames(res);
    await p.running;
    ac.abort();
    expect(await read).toEqual([{ hello: true }]);
    expect(p.state.released).toBe(true);
  });

  test("a request already aborted hands the producer an aborted signal", async () => {
    const ac = new AbortController();
    ac.abort();
    const seen: boolean[] = [];
    const res = ndjsonResponse(
      (_emit, signal) => {
        seen.push(signal.aborted);
        return Promise.resolve();
      },
      { signal: ac.signal },
    );
    expect(await res.text()).toBe("");
    expect(seen).toEqual([true]);
  });
});
