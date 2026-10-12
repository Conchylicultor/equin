/**
 * Deterministic transport fakes for the client live-state harness. Plain `.ts`
 * (NOT `.test.ts`, and NO `vitest`/`bun:test` import) so neither runner ever
 * collects it as a suite and BOTH plugins' suites (networking's own
 * shared-websocket tests, and live-state's notifications tests) can import the
 * identical fakes. Published from this plugin's testing barrel
 * (`@plugins/primitives/plugins/networking/web/testing`), which only test code
 * may import — never from the public `web` barrel.
 *
 * The design mirrors resource-runtime's server-side `test-support.ts`: the fakes
 * are dumb and *scriptable*, never smart mocks. A test drives them by hand
 * (`open()`, `serverSend(frame)`, `kill(tab)`) and asserts on what the REAL
 * production code did in response — the SharedWorker host (`createSharedWsHost`
 * runs in-process, exactly the logic the real worker runs), the tab client, the
 * version guard, keyed-delta merge and backoff are all exercised for real; only
 * the OS globals (`WebSocket`, `SharedWorker` + `MessagePort`,
 * `navigator.locks`, the page lifecycle) are faked. See
 * `research/2026-07-03-global-live-state-client-transport-harness.md` and
 * `research/2026-10-08-networking-shared-worker-transport.md`.
 *
 * Two mechanics are load-bearing for correct fake-timer interleaving (vitest
 * fakes `setTimeout`/`setInterval`/`Date` but NEVER microtasks):
 *   - port delivery and lock grants happen on the REAL microtask queue, so a
 *     test flushes them with `await vi.advanceTimersByTimeAsync(0)` between
 *     faked timers.
 *   - `serverSend` is dropped unless the socket is OPEN — modelling the reopen
 *     gap (a frame to a closed/connecting socket is silently lost), the exact
 *     hazard H1 pins.
 */

import {
  SharedWebSocket,
  type PageLifecycleLike,
  type SharedWebSocketHooks,
  type SharedWebSocketOptions,
} from "../shared-websocket";
import { createSharedWsHost, type SharedWsHost } from "../shared-ws-host";
import type {
  LockManagerLike,
  MessagePortLike,
  SharedWorkerLike,
  WebSocketLike,
} from "../transport-types";

const WS_OPEN = 1;
const WS_CLOSED = 3;

// --- FakeWebSocket + FakeWsServer ------------------------------------------

/**
 * A `WebSocketLike` with no network. Handlers are assigned by the socket owner
 * AFTER construction (never fired synchronously in the constructor), so a test
 * drives lifecycle explicitly: `open()` fires `onopen`, `serverSend` fires
 * `onmessage` (only while OPEN), `serverClose` fires `onclose` (→ reconnect).
 * Client → server frames are captured in `sent`.
 */
export class FakeWebSocket implements WebSocketLike {
  readyState = 0; // CONNECTING
  onopen: ((ev: Event) => void) | null = null;
  onmessage: ((ev: MessageEvent<string>) => void) | null = null;
  onclose: ((ev: CloseEvent) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
  /** Raw frames the production code wrote via `send`, in order. */
  readonly sent: string[] = [];

  constructor(
    readonly url: string,
    private server: FakeWsServer,
  ) {}

  // --- production-facing (WebSocketLike) ---

  send(data: string): void {
    this.sent.push(data);
    this.server.notifyFrame(this, data);
  }

  close(): void {
    if (this.readyState === WS_CLOSED) return;
    this.readyState = WS_CLOSED;
  }

  // --- test affordances ---

  /** Complete the connection: OPEN + fire `onopen`. */
  open(): void {
    if (this.readyState !== 0) return;
    this.readyState = WS_OPEN;
    this.onopen?.(new Event("open"));
  }

  /**
   * Deliver a server → client frame. GUARDED on OPEN: a frame to a
   * closed/connecting socket is silently lost (the reopen gap, hazard H1).
   */
  serverSend(frame: string | object): void {
    if (this.readyState !== WS_OPEN) return;
    const data = typeof frame === "string" ? frame : JSON.stringify(frame);
    this.onmessage?.(new MessageEvent<string>("message", { data }));
  }

  /** Server-initiated close: CLOSED + fire `onclose` (drives the reconnect path). */
  serverClose(code = 1006): void {
    if (this.readyState === WS_CLOSED) return;
    this.readyState = WS_CLOSED;
    this.onclose?.(new CloseEvent("close", { code, wasClean: false }));
  }

  /** Parsed client → server frames, with pings filtered out. */
  sentJson(): Record<string, unknown>[] {
    return this.sent
      .map((s) => JSON.parse(s) as Record<string, unknown>)
      .filter((m) => m.kind !== "ping" && m.op !== "ping");
  }
}

export interface FakeWsServerOptions {
  /**
   * Optional auto-responder: invoked for every client → server frame. Lets a
   * multi-sub test script sub-acks without hand-delivering each. The server fake
   * stays dumb — this is a scripted hook, not a smart mock.
   */
  onFrame?: (socket: FakeWebSocket, frame: string) => void;
}

/**
 * A no-network WebSocket server: `connect` is the bound `makeWebSocket` factory;
 * every socket it ever handed out is retained for introspection (`all`), and the
 * currently-OPEN subset (`openSockets`) is derived live from `readyState` so it
 * is the single source of truth for the one-socket invariant.
 */
export class FakeWsServer {
  private sockets: FakeWebSocket[] = [];
  onFrame?: (socket: FakeWebSocket, frame: string) => void;

  constructor(opts: FakeWsServerOptions = {}) {
    this.onFrame = opts.onFrame;
  }

  /** Bound WebSocket factory — pass as a `makeWebSocket` dependency. */
  connect = (url: string): FakeWebSocket => {
    const ws = new FakeWebSocket(url, this);
    this.sockets.push(ws);
    return ws;
  };

  /** Every socket ever created (open or closed), in creation order. */
  all(): FakeWebSocket[] {
    return [...this.sockets];
  }

  /** Only the currently-OPEN sockets — the one-live-socket invariant reads this. */
  openSockets(): FakeWebSocket[] {
    return this.sockets.filter((s) => s.readyState === WS_OPEN);
  }

  /** Close every OPEN socket (models a backend restart dropping the fleet). */
  restart(): void {
    for (const ws of this.openSockets()) ws.serverClose();
  }

  /** Internal: forward a client-sent frame to the auto-responder, if any. */
  notifyFrame(socket: FakeWebSocket, frame: string): void {
    this.onFrame?.(socket, frame);
  }
}

// --- FakeMessagePort --------------------------------------------------------

/**
 * One end of an entangled `MessageChannel`. `postMessage` delivers a
 * `structuredClone` to the other end on a REAL microtask. A closed port posts
 * nothing and receives nothing; a message posted BEFORE its sender closed is
 * still delivered (a tab's `detach` followed by `close()` arrives).
 */
export class FakeMessagePort implements MessagePortLike {
  onmessage: ((ev: MessageEvent) => void) | null = null;
  closed = false;
  other: FakeMessagePort | null = null;

  postMessage(data: unknown): void {
    if (this.closed) return;
    const to = this.other!;
    const payload: unknown = structuredClone(data);
    queueMicrotask(() => {
      if (to.closed) return;
      if (!to.onmessage) {
        throw new Error(
          "FakeMessagePort: delivery to a port with no onmessage",
        );
      }
      to.onmessage(new MessageEvent("message", { data: payload }));
    });
  }

  close(): void {
    this.closed = true;
  }

  static pair(): [FakeMessagePort, FakeMessagePort] {
    const a = new FakeMessagePort();
    const b = new FakeMessagePort();
    a.other = b;
    b.other = a;
    return [a, b];
  }
}

// --- FakeLockManager --------------------------------------------------------

interface LockRequest {
  cb: () => Promise<void> | void;
  resolve: () => void;
  /** Set once the request has been resolved (guards double-settle). */
  settled: boolean;
}

interface LockState {
  holder: LockRequest | null;
  queue: LockRequest[];
}

/**
 * A `navigator.locks`-shaped exclusive lock, promise-based like the real API.
 * Grants happen on a microtask. One holder per name — enforced by an invariant
 * that THROWS on violation. The lock is held until the callback's returned
 * promise settles; `releaseTab(name)` models the browser freeing a dead tab's
 * locks (the holder is released and the next waiter granted).
 */
export class FakeLockManager implements LockManagerLike {
  private states = new Map<string, LockState>();

  request(
    name: string,
    _options: { mode: "exclusive" },
    callback: () => Promise<void> | void,
  ): Promise<void> {
    const state = this.state(name);
    return new Promise<void>((resolve) => {
      const entry: LockRequest = { cb: callback, resolve, settled: false };
      queueMicrotask(() => {
        if (state.holder) state.queue.push(entry);
        else this.grant(name, entry);
      });
    });
  }

  /** A dead tab: its hold on `name` ends, whatever its callback was awaiting. */
  releaseTab(name: string): void {
    const state = this.state(name);
    if (state.holder) this.release(name, state.holder);
  }

  // --- introspection ---

  isHeld(name: string): boolean {
    return this.state(name).holder !== null;
  }

  queueLength(name: string): number {
    return this.state(name).queue.length;
  }

  // --- internal ---

  private grant(name: string, entry: LockRequest): void {
    const state = this.state(name);
    if (state.holder) {
      throw new Error(
        `FakeLockManager invariant: two holders for lock "${name}"`,
      );
    }
    state.holder = entry;
    void Promise.resolve(entry.cb()).then(() => {
      if (state.holder === entry && !entry.settled) this.release(name, entry);
    });
  }

  private release(name: string, entry: LockRequest): void {
    const state = this.state(name);
    if (state.holder !== entry || entry.settled) return;
    entry.settled = true;
    state.holder = null;
    entry.resolve();
    const next = state.queue.shift();
    if (next) this.grant(name, next);
  }

  private state(name: string): LockState {
    let s = this.states.get(name);
    if (!s) {
      s = { holder: null, queue: [] };
      this.states.set(name, s);
    }
    return s;
  }
}

// --- FakeSharedWorkers ------------------------------------------------------

/**
 * The browser's SharedWorker registry: one REAL `createSharedWsHost` per worker
 * name (the production worker's logic, in-process), shared by every tab;
 * `make(name)` is the `makeSharedWorker` factory, connecting a fresh
 * `MessageChannel` to that host like the worker's `connect` event.
 */
export class FakeSharedWorkers {
  private hosts = new Map<string, SharedWsHost>();

  constructor(
    private server: FakeWsServer,
    private locks: FakeLockManager,
  ) {}

  make = (name: string): SharedWorkerLike & { port: FakeMessagePort } => {
    let host = this.hosts.get(name);
    if (!host) {
      host = createSharedWsHost({
        makeWebSocket: this.server.connect,
        locks: this.locks,
      });
      this.hosts.set(name, host);
    }
    const [tabPort, workerPort] = FakeMessagePort.pair();
    host.connect(workerPort);
    return { port: tabPort, onerror: null };
  };

  /** How many distinct workers exist (one per URL). */
  count(): number {
    return this.hosts.size;
  }
}

// --- FakePageLifecycle ------------------------------------------------------

type LifecycleListener = (ev: { persisted: boolean }) => void;

/** A page's `pagehide` / `pageshow` events, fired by hand. */
export class FakePageLifecycle implements PageLifecycleLike {
  private listeners = new Map<"pagehide" | "pageshow", Set<LifecycleListener>>([
    ["pagehide", new Set()],
    ["pageshow", new Set()],
  ]);

  addEventListener(
    type: "pagehide" | "pageshow",
    listener: LifecycleListener,
  ): void {
    this.listeners.get(type)!.add(listener);
  }

  removeEventListener(
    type: "pagehide" | "pageshow",
    listener: LifecycleListener,
  ): void {
    this.listeners.get(type)!.delete(listener);
  }

  /** `pagehide`; `persisted` = entering the back/forward cache. */
  hide(persisted: boolean): void {
    for (const fn of [...this.listeners.get("pagehide")!]) fn({ persisted });
  }

  /** `pageshow`; `persisted` = restored from the back/forward cache. */
  show(persisted: boolean): void {
    for (const fn of [...this.listeners.get("pageshow")!]) fn({ persisted });
  }
}

// --- Transport hub ----------------------------------------------------------

/**
 * A per-"tab" handle: the `SharedWebSocketHooks` to construct one tab's
 * transport on the shared server/workers/locks, plus what it created (tracked
 * so `kill` acts on exactly this tab).
 */
export interface TabHandle {
  hooks: SharedWebSocketHooks;
  ports: FakeMessagePort[];
  lockNames: string[];
  lifecycle: FakePageLifecycle;
}

export interface TransportHub {
  server: FakeWsServer;
  locks: FakeLockManager;
  workers: FakeSharedWorkers;
  /** A fresh tab's hooks on the shared transport. */
  tab(): TabHandle;
  /**
   * A `NotificationsClient` `makeSocket` hook building real sockets on this
   * tab, with the options the client asks for (its dialect).
   */
  makeSocket(
    tab: TabHandle,
  ): (url: string, options?: SharedWebSocketOptions) => SharedWebSocket;
  /**
   * The tab dies without a word (crash, kill, OS discard): its ports go silent
   * — no `detach` — and the browser frees its locks, which is how the worker
   * learns it is gone.
   */
  kill(tab: TabHandle): void;
}

/** Compose one server + worker registry + lock manager into a multi-tab transport. */
export function createTransportHub(): TransportHub {
  const server = new FakeWsServer();
  const locks = new FakeLockManager();
  const workers = new FakeSharedWorkers(server, locks);

  return {
    server,
    locks,
    workers,
    tab(): TabHandle {
      const handle: TabHandle = {
        hooks: {},
        ports: [],
        lockNames: [],
        lifecycle: new FakePageLifecycle(),
      };
      handle.hooks = {
        makeSharedWorker: (name) => {
          const worker = workers.make(name);
          handle.ports.push(worker.port);
          return worker;
        },
        locks: {
          request: (name, options, callback) => {
            handle.lockNames.push(name);
            return locks.request(name, options, callback);
          },
        },
        pageLifecycle: handle.lifecycle,
      };
      return handle;
    },
    makeSocket(tab: TabHandle) {
      return (url: string, options?: SharedWebSocketOptions) =>
        new SharedWebSocket(url, tab.hooks, options);
    },
    kill(tab: TabHandle): void {
      for (const port of tab.ports) port.close();
      for (const name of tab.lockNames) locks.releaseTab(name);
    },
  };
}
