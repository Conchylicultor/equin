/**
 * SharedWebSocket over the in-page host (`in-page-ws-host.ts`) — what a browser
 * without SharedWorker / Web Locks runs: the REAL tab client and the REAL host,
 * over a REAL `MessageChannel` and the in-page lock, only the server faked.
 *
 * Pins: the consumer-facing behaviour is the shared one's — queue-until-open,
 * onopen once per connection (again after a reconnect), wills on leaving, the
 * last handle closing the socket, pagehide detaching — with one socket per URL
 * in the page.
 */

import { afterEach, describe, expect, test, vi } from "vitest";
import { SharedWebSocket } from "../shared-websocket";
import {
  createInPageLocks,
  createInPageSharedWorkers,
} from "../in-page-ws-host";
import { FakePageLifecycle, FakeWsServer } from "../testing";

const URL_PATH = "/ws/test";
const CLOSED = 3;

describe("SharedWebSocket in the page (no SharedWorker / Web Locks)", () => {
  const built: SharedWebSocket[] = [];
  afterEach(() => {
    for (const s of built.splice(0)) s.close();
  });

  function page(): {
    server: FakeWsServer;
    lifecycle: FakePageLifecycle;
    open(): SharedWebSocket;
  } {
    const server = new FakeWsServer();
    const locks = createInPageLocks();
    const makeSharedWorker = createInPageSharedWorkers({
      makeWebSocket: server.connect,
      locks,
    });
    const lifecycle = new FakePageLifecycle();
    return {
      server,
      lifecycle,
      open() {
        const s = new SharedWebSocket(URL_PATH, {
          makeSharedWorker,
          locks,
          pageLifecycle: lifecycle,
        });
        built.push(s);
        return s;
      },
    };
  }

  test("frames queue until open; onopen fires once per connection; frames reach every handle", async () => {
    const p = page();
    const a = p.open();
    const b = p.open();
    let opens = 0;
    a.onopen = () => opens++;
    a.send("early");
    await vi.waitFor(() => expect(p.server.all()).toHaveLength(1));
    const ws = p.server.all()[0]!;
    ws.open();
    await vi.waitFor(() => expect(a.readyState).toBe(SharedWebSocket.OPEN));
    expect(ws.sent).toEqual(["early"]);
    expect(opens).toBe(1);

    const got: string[] = [];
    a.onmessage = (m) => got.push(`a:${m.data}`);
    b.onmessage = (m) => got.push(`b:${m.data}`);
    ws.serverSend("hello");
    await vi.waitFor(() => expect(got).toEqual(["a:hello", "b:hello"]));
    // One socket per URL in the page, however many handles.
    expect(p.server.all()).toHaveLength(1);
  });

  test("a handle's will reaches the server when it leaves; the last one out closes the socket", async () => {
    const p = page();
    const a = p.open();
    const b = p.open();
    a.setLastWill("bye-a");
    await vi.waitFor(() => expect(p.server.all()).toHaveLength(1));
    const ws = p.server.all()[0]!;
    ws.open();
    await vi.waitFor(() => expect(a.readyState).toBe(SharedWebSocket.OPEN));

    a.close();
    await vi.waitFor(() => expect(ws.sent).toEqual(["bye-a"]));
    expect(ws.readyState).not.toBe(CLOSED);
    b.close();
    await vi.waitFor(() => expect(ws.readyState).toBe(CLOSED));
  });

  test("pagehide detaches (its will sent, the socket closed); a persisted pageshow reconnects and re-dispatches onopen", async () => {
    const p = page();
    const a = p.open();
    a.setLastWill("bye");
    let opens = 0;
    a.onopen = () => opens++;
    await vi.waitFor(() => expect(p.server.all()).toHaveLength(1));
    const ws1 = p.server.all()[0]!;
    ws1.open();
    await vi.waitFor(() => expect(opens).toBe(1));

    p.lifecycle.hide(true);
    await vi.waitFor(() => expect(ws1.readyState).toBe(CLOSED));
    expect(ws1.sent).toEqual(["bye"]);

    p.lifecycle.show(true);
    await vi.waitFor(() => expect(p.server.all()).toHaveLength(2));
    p.server.all()[1]!.open();
    await vi.waitFor(() => expect(opens).toBe(2));
  });

  test("the in-page lock is exclusive, FIFO, and never granted synchronously", async () => {
    const locks = createInPageLocks();
    const order: string[] = [];
    let release!: () => void;
    const first = locks.request("x", { mode: "exclusive" }, () => {
      order.push("first");
      return new Promise<void>((r) => (release = r));
    });
    const second = locks.request("x", { mode: "exclusive" }, () => {
      order.push("second");
    });
    expect(order).toEqual([]);
    await Promise.resolve();
    expect(order).toEqual(["first"]);
    release();
    await first;
    await second;
    expect(order).toEqual(["first", "second"]);
  });
});
