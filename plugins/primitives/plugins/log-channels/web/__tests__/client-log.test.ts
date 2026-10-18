/**
 * clientLog's flush scheduling: the hold after a refused POST (30 s after a
 * `paused` answer, 5 s after a plain failure) gates every trigger but its own retry timer, a WS
 * `open` lifts only a plain-failure hold, and flushes are single-flight so
 * concurrent triggers never interleave batches.
 *
 * The module keeps its state at module level and subscribes to the WS status bus
 * at import, so each test re-imports it fresh (vi.resetModules) with the endpoint
 * and bus mocked.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The endpoints barrel is replaced whole: clientLog uses only `fetchEndpoint`,
// and the tests reject it with an `EndpointError` for a plain failure.
const mocks = vi.hoisted(() => ({
  fetchEndpoint: vi.fn(),
  wsListeners: [] as ((ev: { url: string; status: string }) => void)[],
  EndpointError: class EndpointError extends Error {
    constructor(
      public readonly status: number,
      public readonly body: unknown,
    ) {
      super(`HTTP ${status}`);
    }
  },
}));
const { EndpointError } = mocks;

const ACCEPTED = { status: "accepted" };
const PAUSED = { status: "paused", reason: "duress" };

vi.mock("@plugins/infra/plugins/endpoints/web", () => ({
  fetchEndpoint: mocks.fetchEndpoint,
  EndpointError: mocks.EndpointError,
}));

vi.mock("@plugins/primitives/plugins/networking/web", () => ({
  subscribeWsStatus: (fn: (ev: { url: string; status: string }) => void) => {
    mocks.wsListeners.push(fn);
    return () => undefined;
  },
}));

type ClientLog = typeof import("../client-log").clientLog;
let clientLog: ClientLog;

interface Sent {
  channel: string;
  lines: string[];
}

/** Every POST body sent so far, as (channel, line texts). */
function sent(): Sent[] {
  return mocks.fetchEndpoint.mock.calls.map((call) => {
    const body = (
      call[2] as { body: { channel: string; lines: { line: string }[] } }
    ).body;
    return { channel: body.channel, lines: body.lines.map((l) => l.line) };
  });
}

function wsOpen(): void {
  for (const fn of mocks.wsListeners)
    fn({ url: "ws://x/ws/notifications", status: "open" });
}

/** Let the debounce fire and every awaited POST settle. */
async function settle(ms = 250): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
}

beforeEach(async () => {
  vi.useFakeTimers();
  vi.resetModules();
  mocks.fetchEndpoint.mockReset();
  mocks.wsListeners.length = 0;
  vi.spyOn(console, "debug").mockImplementation(() => undefined);
  ({ clientLog } = await import("../client-log"));
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("clientLog flush hold", () => {
  it("after a paused answer, sends nothing on new lines or WS opens until the 30 s backoff, then retries once in order", async () => {
    mocks.fetchEndpoint.mockResolvedValueOnce(PAUSED);
    clientLog("c", "a");
    await settle();
    expect(sent()).toHaveLength(1);

    mocks.fetchEndpoint.mockResolvedValue(ACCEPTED);
    for (let i = 0; i < 10; i++) {
      clientLog("c", `b${i}`);
      wsOpen();
      await settle(1_000);
    }
    // ~10 s into the hold: still only the one rejected POST.
    expect(sent()).toHaveLength(1);

    await settle(20_000);
    expect(sent()).toHaveLength(2);
    expect(sent()[1]).toEqual({
      channel: "c",
      lines: ["a", ...Array.from({ length: 10 }, (_, i) => `b${i}`)],
    });

    // Hold lifted: the debounce flushes again.
    clientLog("c", "after");
    await settle();
    expect(sent()).toHaveLength(3);
  });

  it("after a plain failure, a WS open flushes immediately", async () => {
    mocks.fetchEndpoint.mockRejectedValueOnce(new EndpointError(502, null));
    clientLog("c", "a");
    await settle();
    expect(sent()).toHaveLength(1);

    mocks.fetchEndpoint.mockResolvedValue(ACCEPTED);
    clientLog("c", "b");
    await settle(1_000);
    expect(sent()).toHaveLength(1); // still held: the debounce is a no-op

    wsOpen();
    await vi.advanceTimersByTimeAsync(0);
    expect(sent()).toHaveLength(2);
    expect(sent()[1]!.lines).toEqual(["a", "b"]);

    // The retry timer was cancelled with the hold — nothing more fires.
    await settle(10_000);
    expect(sent()).toHaveLength(2);
  });

  it("a plain failure retries on its own after 5 s", async () => {
    mocks.fetchEndpoint.mockRejectedValueOnce(new TypeError("fetch failed"));
    clientLog("c", "a");
    await settle();
    mocks.fetchEndpoint.mockResolvedValue(ACCEPTED);
    await settle(4_000);
    expect(sent()).toHaveLength(1);
    await settle(1_000);
    expect(sent()).toHaveLength(2);
  });

  it("stops the pass at the first rejection instead of POSTing every channel", async () => {
    mocks.fetchEndpoint.mockResolvedValue(PAUSED);
    clientLog("a", "1");
    clientLog("b", "2");
    clientLog("c", "3");
    await settle();
    expect(sent()).toHaveLength(1);
  });
});

describe("clientLog single-flight", () => {
  it("concurrent triggers produce one in-flight POST and keep order", async () => {
    let release!: () => void;
    mocks.fetchEndpoint.mockImplementationOnce(
      () => new Promise((r) => (release = () => r(ACCEPTED))),
    );
    mocks.fetchEndpoint.mockResolvedValue(ACCEPTED);

    clientLog("c", "1");
    await settle(); // first POST now in flight
    expect(sent()).toHaveLength(1);

    clientLog("c", "2");
    wsOpen();
    wsOpen();
    await settle(); // debounce fires too
    expect(sent()).toHaveLength(1); // nothing overlaps the in-flight POST

    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(sent().map((s) => s.lines)).toEqual([["1"], ["2"]]);
  });
});
