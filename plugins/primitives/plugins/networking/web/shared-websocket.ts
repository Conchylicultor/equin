import { wsTestHook, type WsTestHook } from "../core";
import { publishWsStatus, type WsStatus } from "./ws-status-bus";
import { publishNetDiag } from "./net-diag-bus";
import {
  SHARED_WS_PROTO,
  portLivenessLockName,
  sharedWsWorkerName,
  type TabToWorker,
  type WorkerToTab,
} from "./shared-ws-protocol";
import type {
  LockManagerLike,
  MakeSharedWorker,
  MessagePortLike,
  SharedWorkerLike,
} from "./transport-types";

/** The page-lifecycle events a tab detaches and re-attaches its port on. */
export interface PageLifecycleLike {
  addEventListener(
    type: "pagehide" | "pageshow",
    listener: (ev: { persisted: boolean }) => void,
  ): void;
  removeEventListener(
    type: "pagehide" | "pageshow",
    listener: (ev: { persisted: boolean }) => void,
  ): void;
}

/**
 * Injection seam for the OS globals this stack touches. All optional —
 * production passes nothing and the globals are used; tests wire the fakes from
 * `./testing`. See
 * `research/2026-10-08-networking-shared-worker-transport.md`.
 */
export interface SharedWebSocketHooks {
  makeSharedWorker?: MakeSharedWorker;
  locks?: LockManagerLike;
  /** `null` ⇒ no page lifecycle (never detaches on its own). Default: `window`. */
  pageLifecycle?: PageLifecycleLike | null;
}

/** What the tab asks of the socket it shares (as opposed to the OS seams in `SharedWebSocketHooks`). */
export interface SharedWebSocketOptions {
  /**
   * Which tabs this one shares a socket with: only those of the same dialect
   * (default: none named — every tab of this networking build). The worker
   * fans every server frame out to every tab on its socket, so a consumer
   * whose server may answer one tab with a frame another tab's code would
   * misread names a dialect: the id of the frame vocabulary its readers
   * speak — tabs that read frames differently then never share a socket.
   *
   * A protocol id, never a build id: it must move exactly when the frames a
   * tab reads change. A per-build value (a module URL, a bundle hash) splits
   * the socket on every unrelated rebuild of the consumer; a hand-bumped
   * version forgets to move. Derive it from the vocabulary itself
   * (live-state passes `PROTOCOL`, `packages/resource-protocol`).
   */
  dialect?: string;
}

function defaultMakeSharedWorker(name: string): SharedWorkerLike {
  if (typeof SharedWorker === "undefined") {
    throw new Error(
      "SharedWebSocket needs SharedWorker, which this browser does not provide " +
        "(Chrome for Android before 148, some embedded webviews).",
    );
  }
  return new SharedWorker(new URL("./shared-ws.worker.ts", import.meta.url), {
    type: "module",
    name,
  });
}

function defaultLocks(): LockManagerLike {
  const locks =
    typeof navigator !== "undefined"
      ? (navigator as Navigator & { locks?: LockManagerLike }).locks
      : undefined;
  if (!locks) {
    throw new Error("SharedWebSocket needs navigator.locks (Web Locks API).");
  }
  return locks;
}

/**
 * A live tab the worker evicted re-attaches — at most `MAX_EVICTIONS` times per
 * `EVICTION_WINDOW_MS`; one more and the socket closes with a thrown error.
 */
const MAX_EVICTIONS = 3;
const EVICTION_WINDOW_MS = 60_000;

/** One attachment of this tab to the worker: a port plus its liveness lock. */
interface PortSession {
  worker: SharedWorkerLike;
  port: MessagePortLike;
  portId: string;
  /** True once `attach` was posted (after the liveness lock is held). */
  attached: boolean;
  /** Frames sent before the attach handshake, flushed right after it. */
  queue: TabToWorker[];
  /** Ends the liveness hold; null until the lock is granted. */
  releaseLock: (() => void) | null;
  /**
   * How this port's liveness lock request stands, from the tab's own side:
   * `"held"` while granted and not yet ended (or still pending), `"ended"` once
   * the hold ended, `"aborted:<name>"` if the browser rejected the request.
   * Read when the worker evicts the port, to name what made it think the tab
   * was gone.
   */
  lock: "held" | "ended" | `aborted:${string}`;
}

// Drop-in replacement for the string-message subset of the native WebSocket
// API, shared across all tabs of the same origin: the real socket lives in a
// SharedWorker (one per URL per networking build), and every tab talks to it
// through a MessagePort. No tab owns the socket, so closing or freezing any tab
// never interrupts the others.
export class SharedWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readonly url: string;
  readyState: number = SharedWebSocket.CONNECTING;

  onopen: ((ev: Event) => void) | null = null;
  onmessage: ((ev: MessageEvent<string>) => void) | null = null;
  onclose: ((ev: CloseEvent) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;

  private readonly absUrl: string;
  private readonly dialect: string | undefined;
  private readonly makeSharedWorker: MakeSharedWorker;
  private readonly locks: LockManagerLike;
  private readonly lifecycle: PageLifecycleLike | null;
  private session: PortSession | null = null;
  private will: string | null = null;
  private closed = false;
  /** An e2e test's hook (`core/ws-test-hook.ts`); undefined in every real session. */
  private readonly testHook: WsTestHook | undefined = wsTestHook();
  private lastStatus: WsStatus | null = null;
  private portCount: number | null = null;
  /**
   * Identity of the server connection this tab last dispatched `onopen` for —
   * the one its consumers' state (NotificationsClient's subs) is registered
   * on. The worker mints a fresh id per real socket open. `null` = not bound to
   * any connection (never opened, a drop since, or a re-attach).
   */
  private boundConn: string | null = null;
  /** `Date.now()` of each recent eviction (see the `released` message). */
  private evictions: number[] = [];

  constructor(
    url: string | URL,
    hooks?: SharedWebSocketHooks,
    options?: SharedWebSocketOptions,
  ) {
    this.url = typeof url === "string" ? url : url.toString();
    this.dialect = options?.dialect;
    this.makeSharedWorker = hooks?.makeSharedWorker ?? defaultMakeSharedWorker;
    this.locks = hooks?.locks ?? defaultLocks();
    this.lifecycle =
      hooks?.pageLifecycle !== undefined
        ? hooks.pageLifecycle
        : typeof window !== "undefined"
          ? window
          : null;

    const proto =
      typeof location !== "undefined" && location.protocol === "https:"
        ? "wss"
        : "ws";
    const host = typeof location !== "undefined" ? location.host : "";
    this.absUrl = /^wss?:\/\//i.test(this.url)
      ? this.url
      : `${proto}://${host}${this.url}`;

    this.lifecycle?.addEventListener("pagehide", this.onPageHide);
    this.lifecycle?.addEventListener("pageshow", this.onPageShow);
    if (this.testHook) {
      const fault = (f: "drop" | "hold" | "release") => () =>
        this.postToWorker({ kind: "test-fault", fault: f });
      this.testHook.controls[this.url] = {
        drop: fault("drop"),
        hold: fault("hold"),
        release: fault("release"),
      };
    }
    this.attach();
  }

  send(data: string): void {
    if (this.closed) return;
    this.testHook?.onEvent({ url: this.url, kind: "tx", data });
    this.postToWorker({ kind: "tx", data });
  }

  /**
   * The frame the worker sends the server when this tab leaves — on `close()`,
   * on pagehide, or when the tab dies without either (crash, kill). `null`
   * clears it. Lets a consumer release its server-side state for a departed tab
   * however it departed.
   */
  setLastWill(data: string | null): void {
    this.will = data;
    if (this.session?.attached) {
      this.session.port.postMessage({
        kind: "will",
        data,
      } satisfies TabToWorker);
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.readyState = SharedWebSocket.CLOSED;
    this.lifecycle?.removeEventListener("pagehide", this.onPageHide);
    this.lifecycle?.removeEventListener("pageshow", this.onPageShow);
    this.detach();
    /* eslint-disable promise-safety/no-bare-catch -- a throwing onclose listener must not break close() */
    try {
      this.onclose?.(
        new CloseEvent("close", {
          code: 1000,
          reason: "handle closed",
          wasClean: true,
        }),
      );
    } catch {
      /* ignore */
    }
    /* eslint-enable promise-safety/no-bare-catch */
  }

  // --- port session -----------------------------------------------------------

  private attach(): void {
    const portId = crypto.randomUUID();
    const worker = this.makeSharedWorker(
      sharedWsWorkerName(this.absUrl, this.dialect),
    );
    const session: PortSession = {
      worker,
      port: worker.port,
      portId,
      attached: false,
      queue: [],
      releaseLock: null,
      lock: "held",
    };
    this.session = session;
    worker.onerror = () => this.onWorkerError(session);
    session.port.onmessage = (ev: MessageEvent<WorkerToTab>) =>
      this.onWorkerMessage(session, ev.data);

    // Hold the liveness lock for the port's whole life, and attach only once it
    // is held: the worker queues for the same lock, so a grant before ours
    // would read as "this tab is already gone".
    const lockSettled = this.locks.request(
      portLivenessLockName(portId),
      { mode: "exclusive" },
      () =>
        new Promise<void>((resolve) => {
          if (this.session !== session) {
            resolve(); // detached before the grant: nothing to hold
            return;
          }
          session.releaseLock = resolve;
          const post = (msg: TabToWorker): void =>
            session.port.postMessage(msg);
          post({
            kind: "attach",
            url: this.absUrl,
            portId,
            proto: SHARED_WS_PROTO,
            holdConnects:
              this.testHook?.holdFromStart.includes(this.url) ?? false,
          });
          if (this.will !== null) post({ kind: "will", data: this.will });
          session.attached = true;
          for (const msg of session.queue.splice(0)) post(msg);
        }),
    );
    // The request settles when the hold ends — our own detach, or the browser
    // ending it under us. Recorded, not acted on: an eviction reads it.
    void lockSettled.then(
      () => {
        session.lock = "ended";
      },
      (err: unknown) => {
        if (!(err instanceof DOMException)) throw err;
        session.lock = `aborted:${err.name}`;
      },
    );
  }

  private detach(): void {
    const session = this.session;
    if (!session) return;
    this.session = null;
    if (session.attached) {
      session.port.postMessage({ kind: "detach" } satisfies TabToWorker);
    }
    session.port.onmessage = null;
    session.worker.onerror = null;
    session.port.close();
    session.releaseLock?.();
  }

  private postToWorker(msg: TabToWorker): void {
    const session = this.session;
    if (!session) return; // detached (bfcache): nothing reaches the server
    if (session.attached) session.port.postMessage(msg);
    else session.queue.push(msg);
  }

  // Always detach on pagehide: a page entering the bfcache is frozen, and a
  // port it still held would look alive to the worker. Restored ⇒ a fresh port,
  // and `boundConn = null` so the attach reply re-dispatches `onopen` — the
  // will released this tab's server state on the way out.
  private onPageHide = (): void => {
    if (this.closed) return;
    this.detach();
    this.boundConn = null;
    this.readyState = SharedWebSocket.CONNECTING;
  };

  private onPageShow = (ev: { persisted: boolean }): void => {
    if (this.closed || !ev.persisted || this.session) return;
    this.attach();
  };

  private onWorkerMessage(session: PortSession, msg: WorkerToTab): void {
    if (session !== this.session) return; // a message for a detached port
    switch (msg.kind) {
      case "status":
        this.testHook?.onEvent({
          url: this.url,
          kind: "status",
          status: msg.status,
          conn: msg.conn,
        });
        this.portCount = msg.ports;
        if (msg.status === "open" && msg.conn !== null) {
          this.readyState = SharedWebSocket.OPEN;
          this.setStatus("open");
          // Consumers treat onopen as "fresh connection, replay state"
          // (NotificationsClient replays its whole sub set), so it dispatches
          // exactly once per server connection — keyed by the connection's
          // identity: the worker re-sends status on every port join/leave, and
          // only a NEW connection (or a re-attach) may re-dispatch.
          if (msg.conn !== this.boundConn) {
            this.boundConn = msg.conn;
            this.dispatch(() => this.onopen?.(new Event("open")));
          }
        } else {
          this.boundConn = null;
          this.readyState = SharedWebSocket.CONNECTING;
          this.setStatus(msg.status);
        }
        return;
      case "rx":
        this.testHook?.onEvent({ url: this.url, kind: "rx", data: msg.data });
        this.dispatch(() =>
          this.onmessage?.(new MessageEvent("message", { data: msg.data })),
        );
        return;
      case "ws-error":
        this.dispatch(() => this.onerror?.(new Event("error")));
        return;
      case "diag":
        publishNetDiag(msg.event);
        return;
      case "released":
        // The worker dropped this port as "gone" while this tab is alive (it
        // never detached — a detached session's messages are ignored above).
        // Report what the tab's own lock says, THEN re-attach: the report is
        // the record of the cause; the re-attach only stops the page from
        // waiting forever on a port nobody reads.
        publishNetDiag({
          type: "port-evicted",
          url: this.absUrl,
          attachedMs: msg.attachedMs,
          tabLock: session.lock,
        });
        this.detach();
        {
          const now = Date.now();
          this.evictions = this.evictions.filter(
            (t) => now - t < EVICTION_WINDOW_MS,
          );
          this.evictions.push(now);
          // Evicted again and again: the cause is not transient, and
          // re-attaching would only spin. Stop and fail loudly.
          if (this.evictions.length > MAX_EVICTIONS) {
            this.setStatus("closed");
            throw new Error(
              `SharedWebSocket ${this.url}: the shared-ws worker evicted this live tab ${this.evictions.length} times in ${EVICTION_WINDOW_MS / 1000}s (tab lock: ${session.lock}) — giving up`,
            );
          }
        }
        this.boundConn = null;
        this.readyState = SharedWebSocket.CONNECTING;
        this.attach();
        return;
      case "fatal":
        this.detach();
        this.setStatus("closed");
        throw new Error(`SharedWebSocket ${this.url}: ${msg.message}`);
    }
  }

  private onWorkerError(session: PortSession): void {
    if (session !== this.session) return;
    this.detach();
    this.setStatus("closed");
    throw new Error(
      `SharedWebSocket ${this.url}: the shared-ws worker failed to load or crashed`,
    );
  }

  /** A throwing consumer listener must not break the transport. */
  private dispatch(fn: () => void): void {
    /* eslint-disable promise-safety/no-bare-catch -- a throwing listener must not break the transport */
    try {
      fn();
    } catch {
      /* ignore */
    }
    /* eslint-enable promise-safety/no-bare-catch */
  }

  // --- introspection (read-only; Layer 2 inspector) -------------------------

  /** Last-published status for this socket (null until the first transition). */
  get status(): WsStatus | null {
    return this.lastStatus;
  }

  /** Tabs attached to the shared socket, as last reported by the worker (null before attach). */
  get attachedTabs(): number | null {
    return this.portCount;
  }

  /** The server connection this tab is bound to (null while not open). */
  get connection(): string | null {
    return this.boundConn;
  }

  // --- status bus -----------------------------------------------------------

  private setStatus(status: WsStatus): void {
    if (this.lastStatus === status) return;
    this.lastStatus = status;
    publishWsStatus({ url: this.url, status });
  }
}
