/**
 * SharedWebSocket + its SharedWorker host, driven on a full
 * `createTransportHub()`: the REAL tab client and the REAL worker host
 * (`createSharedWsHost`, in-process) run end to end — attach handshake behind
 * the liveness lock, queue-until-open, reconnect backoff, fan-out, wills — and
 * only the OS globals are faked.
 *
 * Pins (see `research/2026-10-08-networking-shared-worker-transport.md`):
 *   - one real socket per URL however many tabs attach (per dialect: tabs of
 *     another dialect never share it);
 *   - onopen dispatches exactly once per server connection per tab (consumers
 *     replay their subs there): a joining tab does not re-dispatch the others,
 *     a reconnect re-dispatches everyone;
 *   - a tab dying (no detach) or leaving never interrupts the others' socket;
 *   - a departing tab's will reaches the server, whichever way it departed;
 *   - the last tab leaving closes the socket;
 *   - bfcache: pagehide detaches, a persisted pageshow re-attaches and replays.
 *
 * Conventions: fake timers per test; advance only via the async variants;
 * Math.random pinned to 0.5 (delay = base·(0.5+0.5) = base); every constructed
 * SharedWebSocket is closed in afterEach (module-level buses are shared).
 */

import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import {
  WS_TEST_HOOK_GLOBAL,
  type WsTestEvent,
  type WsTestHook,
} from "../../core";
import { SharedWebSocket } from "../shared-websocket";
import { CONNECT_DEADLINE_MS } from "../socket-owner";
import { subscribeNetDiag, type NetDiagEvent } from "../net-diag-bus";
import { createSharedWsHost } from "../shared-ws-host";
import { SHARED_WS_PROTO, type WorkerToTab } from "../shared-ws-protocol";
import {
  createTransportHub,
  FakeLockManager,
  FakeMessagePort,
  FakeWsServer,
} from "../testing";

const URL_PATH = "/ws/test";
const CLOSED = 3;

const flush = async (): Promise<void> => {
  await vi.advanceTimersByTimeAsync(0);
};

describe("SharedWebSocket", () => {
  const built: SharedWebSocket[] = [];
  const track = (s: SharedWebSocket): SharedWebSocket => {
    built.push(s);
    return s;
  };

  beforeEach(() => {
    vi.useFakeTimers();
    // Pin backoff jitter: delay = base · (0.5 + 0.5) = base exactly.
    vi.spyOn(Math, "random").mockReturnValue(0.5);
  });

  afterEach(() => {
    for (const s of built.splice(0)) s.close();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  function counter(sws: SharedWebSocket): { opens: number } {
    const c = { opens: 0 };
    sws.onopen = () => {
      c.opens++;
    };
    return c;
  }

  test("frames sent before the attach handshake and before open flush in order", async () => {
    const hub = createTransportHub();
    const sws = track(new SharedWebSocket(URL_PATH, hub.tab().hooks));
    sws.send("a"); // before the liveness lock is even granted
    await flush(); // attach → worker creates the socket (connecting)
    sws.send("b");
    sws.send("c");
    await flush();

    const ws = hub.server.all()[0]!;
    expect(ws.sent).toEqual([]); // connecting → queued in the worker
    ws.open();
    expect(ws.sent).toEqual(["a", "b", "c"]);
    await flush();
    expect(sws.status).toBe("open");
    expect(sws.readyState).toBe(SharedWebSocket.OPEN);
  });

  test("an incoming server frame reaches every tab's onmessage", async () => {
    const hub = createTransportHub();
    const a = track(new SharedWebSocket(URL_PATH, hub.tab().hooks));
    const b = track(new SharedWebSocket(URL_PATH, hub.tab().hooks));
    await flush();
    hub.server.all()[0]!.open();
    await flush();

    const got: string[] = [];
    a.onmessage = (ev) => got.push(`a:${ev.data}`);
    b.onmessage = (ev) => got.push(`b:${ev.data}`);
    hub.server.all()[0]!.serverSend("frame-1");
    await flush();
    expect(got).toEqual(["a:frame-1", "b:frame-1"]);
  });

  test("one real socket per URL however many tabs attach; a second URL gets its own worker", async () => {
    const hub = createTransportHub();
    for (let i = 0; i < 3; i++) {
      track(new SharedWebSocket(URL_PATH, hub.tab().hooks));
    }
    await flush();
    expect(hub.server.all()).toHaveLength(1);

    track(new SharedWebSocket("/ws/other", hub.tab().hooks));
    await flush();
    expect(hub.workers.count()).toBe(2);
    expect(hub.server.all()).toHaveLength(2);
  });

  test("tabs share a socket only within one dialect: another dialect of the URL gets its own worker, and none of its frames", async () => {
    const hub = createTransportHub();
    const a = track(
      new SharedWebSocket(URL_PATH, hub.tab().hooks, { dialect: "v2" }),
    );
    const b = track(
      new SharedWebSocket(URL_PATH, hub.tab().hooks, { dialect: "v2" }),
    );
    const old = track(new SharedWebSocket(URL_PATH, hub.tab().hooks));
    await flush();
    expect(hub.workers.count()).toBe(2);
    expect(hub.server.all()).toHaveLength(2);
    for (const ws of hub.server.all()) ws.open();
    await flush();

    const got: string[] = [];
    a.onmessage = (ev) => got.push(`a:${ev.data}`);
    b.onmessage = (ev) => got.push(`b:${ev.data}`);
    old.onmessage = (ev) => got.push(`old:${ev.data}`);
    a.send("sub");
    await flush();
    const ws = hub.server.all().find((w) => w.sent.includes("sub"))!;
    ws.serverSend("answer");
    await flush();
    expect(got).toEqual(["a:answer", "b:answer"]);
  });

  test("reconnect backoff: 500 → new socket, index advances to 1000, resets on open", async () => {
    const hub = createTransportHub();
    const sws = track(new SharedWebSocket(URL_PATH, hub.tab().hooks));
    await flush();
    const ws1 = hub.server.all()[0]!;
    ws1.open();
    await flush();
    expect(sws.status).toBe("open");

    ws1.serverClose();
    await flush();
    expect(sws.status).toBe("reconnecting");
    await vi.advanceTimersByTimeAsync(499);
    expect(hub.server.all()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(hub.server.all()).toHaveLength(2);

    // ws2 drops WITHOUT opening → the backoff index advanced to 1 = 1000ms.
    hub.server.all()[1]!.serverClose();
    await vi.advanceTimersByTimeAsync(999);
    expect(hub.server.all()).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(hub.server.all()).toHaveLength(3);

    // ws3 opens → attempt resets; the next drop is back to the 500ms base.
    const ws3 = hub.server.all()[2]!;
    ws3.open();
    ws3.serverClose();
    await vi.advanceTimersByTimeAsync(499);
    expect(hub.server.all()).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(1);
    expect(hub.server.all()).toHaveLength(4);
  });

  test("a makeWebSocket SyntaxError schedules a reconnect instead of crashing", async () => {
    const server = new FakeWsServer();
    const locks = new FakeLockManager();
    let throwNext = true;
    const host = createSharedWsHost({
      makeWebSocket: (url) => {
        if (throwNext) {
          throwNext = false;
          throw new SyntaxError("bad url");
        }
        return server.connect(url);
      },
      locks,
    });
    track(
      new SharedWebSocket(URL_PATH, {
        makeSharedWorker: () => {
          const [tabPort, workerPort] = FakeMessagePort.pair();
          host.connect(workerPort);
          return { port: tabPort, onerror: null };
        },
        locks,
        pageLifecycle: null,
      }),
    );
    await flush();
    expect(server.all()).toHaveLength(0); // did not crash, no socket yet

    await vi.advanceTimersByTimeAsync(500); // backoff retry succeeds
    expect(server.all()).toHaveLength(1);
  });

  test("onopen: once per connection per tab — a join re-dispatches nobody, a reconnect re-dispatches everyone", async () => {
    const hub = createTransportHub();
    const a = track(new SharedWebSocket(URL_PATH, hub.tab().hooks));
    const ca = counter(a);
    await flush();
    const s1 = hub.server.all()[0]!;
    s1.open();
    await flush();
    expect(ca.opens).toBe(1);

    // B attaches to the already-open socket: B dispatches, A does not.
    const b = track(new SharedWebSocket(URL_PATH, hub.tab().hooks));
    const cb = counter(b);
    await flush();
    expect(cb.opens).toBe(1);
    expect(b.status).toBe("open");
    expect(ca.opens).toBe(1);
    expect(a.attachedTabs).toBe(2);

    // A genuine reconnect is a new connection: everyone re-dispatches.
    s1.serverClose();
    await flush();
    expect(a.status).toBe("reconnecting");
    expect(b.status).toBe("reconnecting");
    await vi.advanceTimersByTimeAsync(500);
    hub.server.all()[1]!.open();
    await flush();
    expect(ca.opens).toBe(2);
    expect(cb.opens).toBe(2);
  });

  test("killing the tab that attached first leaves the others on the same open socket", async () => {
    const hub = createTransportHub();
    const tabA = hub.tab();
    track(new SharedWebSocket(URL_PATH, tabA.hooks));
    const b = track(new SharedWebSocket(URL_PATH, hub.tab().hooks));
    const cb = counter(b);
    await flush();
    const ws = hub.server.all()[0]!;
    ws.open();
    await flush();
    expect(cb.opens).toBe(1);

    hub.kill(tabA);
    await flush();
    expect(hub.server.all()).toHaveLength(1); // no new socket, no reconnect
    expect(hub.server.openSockets()).toEqual([ws]);
    expect(b.status).toBe("open");
    expect(cb.opens).toBe(1); // same connection: no replay
    expect(b.attachedTabs).toBe(1);

    const got: string[] = [];
    b.onmessage = (ev) => got.push(ev.data);
    ws.serverSend("still-live");
    await flush();
    expect(got).toEqual(["still-live"]);
  });

  test("a departing tab's will reaches the server — on kill and on close — and null clears it", async () => {
    const hub = createTransportHub();
    const tabA = hub.tab();
    const a = track(new SharedWebSocket(URL_PATH, tabA.hooks));
    const b = track(new SharedWebSocket(URL_PATH, hub.tab().hooks));
    const c = track(new SharedWebSocket(URL_PATH, hub.tab().hooks));
    a.setLastWill("bye-a"); // set before the handshake: sent with the attach
    b.setLastWill("bye-b");
    await flush();
    const ws = hub.server.all()[0]!;
    ws.open();
    await flush();
    c.setLastWill("bye-c"); // set after: sent on its own
    c.setLastWill(null); // …and cleared
    await flush();

    hub.kill(tabA); // dies without a word: the lock frees
    await flush();
    expect(ws.sent).toEqual(["bye-a"]);

    b.close(); // clean departure: detach
    await flush();
    expect(ws.sent).toEqual(["bye-a", "bye-b"]);

    c.close(); // no will; last tab out closes the socket
    await flush();
    expect(ws.sent).toEqual(["bye-a", "bye-b"]);
    expect(ws.readyState).toBe(CLOSED);
  });

  test("the last tab leaving closes the socket; the next tab opens a fresh one", async () => {
    const hub = createTransportHub();
    const a = track(new SharedWebSocket(URL_PATH, hub.tab().hooks));
    await flush();
    const ws1 = hub.server.all()[0]!;
    ws1.open();
    await flush();

    a.close();
    await flush();
    expect(ws1.readyState).toBe(CLOSED);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(hub.server.all()).toHaveLength(1); // closed, not reconnecting

    const b = track(new SharedWebSocket(URL_PATH, hub.tab().hooks));
    const cb = counter(b);
    await flush();
    expect(hub.server.all()).toHaveLength(2);
    hub.server.all()[1]!.open();
    await flush();
    expect(cb.opens).toBe(1);
  });

  test("bfcache: pagehide detaches (will sent), a persisted pageshow re-attaches and re-dispatches onopen once", async () => {
    const hub = createTransportHub();
    const tabA = hub.tab();
    const a = track(new SharedWebSocket(URL_PATH, tabA.hooks));
    a.setLastWill("bye-a");
    const ca = counter(a);
    track(new SharedWebSocket(URL_PATH, hub.tab().hooks)); // keeps the socket alive
    await flush();
    const ws = hub.server.all()[0]!;
    ws.open();
    await flush();
    expect(ca.opens).toBe(1);

    tabA.lifecycle.hide(true);
    await flush();
    expect(ws.sent).toEqual(["bye-a"]); // server released A's state
    a.send("while-frozen"); // dropped: a frozen page reaches nothing
    await flush();
    expect(ws.sent).toEqual(["bye-a"]);

    tabA.lifecycle.show(true);
    await flush();
    expect(ca.opens).toBe(2); // same connection, but A must replay its state
    expect(a.status).toBe("open");
    expect(hub.server.all()).toHaveLength(1);
  });

  test("the worker host rejects a port speaking another protocol version", async () => {
    const host = createSharedWsHost({
      makeWebSocket: new FakeWsServer().connect,
      locks: new FakeLockManager(),
    });
    const [tabPort, workerPort] = FakeMessagePort.pair();
    host.connect(workerPort);
    const got: WorkerToTab[] = [];
    tabPort.onmessage = (ev) => got.push(ev.data as WorkerToTab);
    tabPort.postMessage({
      kind: "attach",
      url: "ws://x/ws/test",
      portId: "p1",
      proto: SHARED_WS_PROTO + 1,
      holdConnects: false,
    });
    await flush();
    expect(workerPort.closed).toBe(true);
    expect(got).toEqual([
      {
        kind: "fatal",
        message: `shared-ws protocol mismatch: tab speaks ${SHARED_WS_PROTO + 1}, worker ${SHARED_WS_PROTO}`,
      },
    ]);
  });

  describe("e2e test hook (core/ws-test-hook.ts)", () => {
    function installHook(holdFromStart: string[] = []): {
      hook: WsTestHook;
      events: WsTestEvent[];
    } {
      const events: WsTestEvent[] = [];
      const hook: WsTestHook = {
        holdFromStart,
        controls: {},
        onEvent: (e) => events.push(e),
      };
      Object.assign(globalThis, { [WS_TEST_HOOK_GLOBAL]: hook });
      return { hook, events };
    }
    afterEach(() => {
      Reflect.deleteProperty(globalThis, WS_TEST_HOOK_GLOBAL);
    });

    test("with no hook installed, nothing is reported and no controls exist", async () => {
      const hub = createTransportHub();
      track(new SharedWebSocket(URL_PATH, hub.tab().hooks));
      await flush();
      expect(WS_TEST_HOOK_GLOBAL in globalThis).toBe(false);
      expect(hub.server.all()).toHaveLength(1);
    });

    test("reports status, rx and tx, and registers controls by URL", async () => {
      const { hook, events } = installHook();
      const hub = createTransportHub();
      const sws = track(new SharedWebSocket(URL_PATH, hub.tab().hooks));
      expect(Object.keys(hook.controls)).toEqual([URL_PATH]);
      await flush();
      const ws = hub.server.all()[0]!;
      ws.open();
      await flush();
      sws.send("up");
      ws.serverSend("down");
      await flush();
      expect(events.map((e) => e.kind)).toEqual([
        "status",
        "status",
        "tx",
        "rx",
      ]);
      expect(events[1]).toMatchObject({ kind: "status", status: "open" });
      expect(events.slice(2)).toEqual([
        { url: URL_PATH, kind: "tx", data: "up" },
        { url: URL_PATH, kind: "rx", data: "down" },
      ]);
    });

    test("drop + hold: the connection is lost, no reconnect dials until release, then onopen re-dispatches", async () => {
      const { hook } = installHook();
      const hub = createTransportHub();
      const sws = track(new SharedWebSocket(URL_PATH, hub.tab().hooks));
      const c = counter(sws);
      await flush();
      const ws1 = hub.server.all()[0]!;
      ws1.open();
      await flush();
      expect(c.opens).toBe(1);

      hook.controls[URL_PATH]!.hold();
      hook.controls[URL_PATH]!.drop();
      await flush();
      expect(ws1.readyState).toBe(CLOSED);
      expect(sws.status).toBe("reconnecting");
      await vi.advanceTimersByTimeAsync(30_000); // backoff fires, then parks
      expect(hub.server.all()).toHaveLength(1);

      hook.controls[URL_PATH]!.release();
      await flush();
      expect(hub.server.all()).toHaveLength(2);
      hub.server.all()[1]!.open();
      await flush();
      expect(c.opens).toBe(2);
    });

    test("holdFromStart: the socket never dials until released", async () => {
      const { hook } = installHook([URL_PATH]);
      const hub = createTransportHub();
      track(new SharedWebSocket(URL_PATH, hub.tab().hooks));
      await vi.advanceTimersByTimeAsync(30_000);
      expect(hub.server.all()).toHaveLength(0);
      hook.controls[URL_PATH]!.release();
      await flush();
      expect(hub.server.all()).toHaveLength(1);
    });
  });
});

/**
 * Transport faults the networking layer recovers from — each one PUBLISHED on
 * the net-diag bus before it heals, so the recovery never hides the cause
 * (infra/health's watchdog turns these into reports).
 */
describe("SharedWebSocket — reported recoveries", () => {
  const built: SharedWebSocket[] = [];
  let diag: NetDiagEvent[] = [];
  let unsub: () => void = () => {};

  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    diag = [];
    unsub = subscribeNetDiag((ev) => diag.push(ev));
  });

  afterEach(() => {
    unsub();
    for (const s of built.splice(0)) s.close();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  test("a handshake that never answers is reported as ws-connect-stalled, then abandoned and redialed", async () => {
    const hub = createTransportHub();
    const sws = new SharedWebSocket(URL_PATH, hub.tab().hooks);
    built.push(sws);
    await flush();
    expect(hub.server.all()).toHaveLength(1);
    expect(sws.status).toBe("connecting");

    await vi.advanceTimersByTimeAsync(CONNECT_DEADLINE_MS - 1);
    expect(diag.some((e) => e.type === "ws-connect-stalled")).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(diag.find((e) => e.type === "ws-connect-stalled")).toMatchObject({
      type: "ws-connect-stalled",
      elapsedMs: CONNECT_DEADLINE_MS,
      attempt: 0,
    });
    expect(hub.server.all()[0]!.readyState).toBe(CLOSED);
    expect(sws.status).toBe("reconnecting");

    await vi.advanceTimersByTimeAsync(500); // first backoff step
    expect(hub.server.all()).toHaveLength(2);
    hub.server.all()[1]!.open();
    await flush();
    expect(sws.status).toBe("open");
  });

  test("an open connection is never abandoned by the connect deadline", async () => {
    const hub = createTransportHub();
    built.push(new SharedWebSocket(URL_PATH, hub.tab().hooks));
    await flush();
    hub.server.all()[0]!.open();
    await vi.advanceTimersByTimeAsync(CONNECT_DEADLINE_MS * 3);
    expect(diag.some((e) => e.type === "ws-connect-stalled")).toBe(false);
    expect(hub.server.openSockets()).toHaveLength(1);
  });

  test("a live tab whose liveness lock the worker was granted is told, reports port-evicted, and re-attaches", async () => {
    const hub = createTransportHub();
    const tab = hub.tab();
    const sws = new SharedWebSocket(URL_PATH, tab.hooks);
    built.push(sws);
    // A second tab keeps the shared connection alive across the eviction.
    built.push(new SharedWebSocket(URL_PATH, hub.tab().hooks));
    let opens = 0;
    sws.onopen = () => {
      opens++;
    };
    await flush();
    const ws = hub.server.all()[0]!;
    ws.open();
    await flush();
    expect(opens).toBe(1);

    // The tab's hold ends WITHOUT the tab detaching (its port stays alive):
    // the worker is granted the lock and reads the tab as gone.
    hub.locks.releaseTab(tab.lockNames[0]!);
    await flush();

    expect(diag.find((e) => e.type === "port-evicted")).toMatchObject({
      type: "port-evicted",
      tabLock: "ended",
    });
    // Re-attached on a fresh port: the same server connection, onopen
    // re-dispatched so consumers replay, and frames reach the server again.
    expect(tab.ports).toHaveLength(2);
    expect(hub.server.all()).toHaveLength(1);
    expect(opens).toBe(2);
    sws.send("after-eviction");
    await flush();
    expect(ws.sent).toContain("after-eviction");
  });
});
