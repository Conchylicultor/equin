import { wsTestHook, type WsTestHook } from "../core";
import { publishWsStatus, type WsStatus } from "./ws-status-bus";
import { nativeWebSocket } from "@plugins/primitives/plugins/networking/plugins/request-guard/web";
import { publishNetDiag } from "./net-diag-bus";
import {
  markPageReach,
  pageReachLostSince,
  whenPageCanFetch,
  type ReachMark,
} from "@plugins/framework/plugins/web-sdk/core";
import {
  runMarked,
  type TaskMarkText,
} from "@plugins/primitives/plugins/perfs/plugins/task-marks/core";
import {
  createInPageLocks,
  createInPageSharedWorkers,
} from "./in-page-ws-host";
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

/**
 * One server frame as a socket hands it to its consumer. `arrivedAt`
 * (`Date.now()`) is when it reached the browser — stamped by whatever holds
 * the real socket (the SharedWorker; an in-page server's delivery), not by the
 * consumer's handler, which a busy main thread delays.
 */
export interface SocketMessage {
  readonly data: string;
  readonly arrivedAt: number;
}

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
 * When this tab's page runs again after a pause: `subscribe(fn)` calls `fn` on
 * each resume and returns its unsubscribe.
 */
export interface PageResumeLike {
  subscribe(fn: () => void): () => void;
}

/**
 * The page's own resumes: back to visible (`visibilitychange`), or a frozen
 * page resuming (`resume`, Chrome's Page Lifecycle) — the moments a woken
 * device's tabs resync.
 */
function documentResume(): PageResumeLike | null {
  if (typeof document === "undefined") return null;
  return {
    subscribe(fn) {
      const onVisibility = () => {
        if (document.visibilityState === "visible") fn();
      };
      document.addEventListener("visibilitychange", onVisibility);
      document.addEventListener("resume", fn);
      return () => {
        document.removeEventListener("visibilitychange", onVisibility);
        document.removeEventListener("resume", fn);
      };
    },
  };
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
  /** `null` ⇒ no resume signal (a link is never doubted). Default: `document`'s. */
  pageResume?: PageResumeLike | null;
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
   * (live-state passes `PROTOCOL`, `network/live/resource-protocol`).
   */
  dialect?: string;
  /**
   * This tab's address on the shared socket: a server frame addressed to
   * other tabs (`core/addressed-frame.ts`) never reaches this one — the worker
   * reads the address and posts only the body, only to the ports it names. A
   * consumer whose server addresses its frames (live-state: each to the tabs
   * holding its subscription) passes the id its frames name it by. Absent:
   * only unaddressed frames reach the tab.
   */
  address?: string;
  /**
   * The server's heartbeat: it sends every open socket a frame at least this
   * often (live-state passes the resource runtime's `HEARTBEAT_MS`). When this
   * tab's page resumes (visible again, unfrozen) onto a link that has carried
   * nothing for longer, the socket doubts it, and replaces it (`ws-silent`)
   * if it still delivers nothing — a link a sleep left dead or stalled —
   * instead of letting the tab's resync wait on it until TCP gives up, a
   * minute or more later (`SocketOwner.checkLink`). Absent: a server that
   * promises nothing; a link is never doubted.
   *
   * A fact about the server's protocol, so tabs sharing a socket (one
   * dialect) must agree on it: an attach naming another value is refused.
   */
  heartbeatMs?: number;
}

/**
 * A worker message as a task mark (`primitives/perfs/task-marks`): its kind —
 * and the status / diag event it carries, the grain a recurring freeze groups
 * by — and its size for a frame. LoAF names only the port handler, the entry
 * point of EVERY message, so the mark is what says which one froze the tab.
 * Cheap by construction: no payload is read beyond a length.
 */
function portMark(url: string, msg: WorkerToTab): TaskMarkText {
  switch (msg.kind) {
    case "status":
      return { what: `port status ${msg.status}`, detail: url };
    case "rx":
      return { what: "port rx", detail: `${url} ${msg.data.length} B` };
    case "diag":
      return { what: `port diag ${msg.event.type}`, detail: url };
    case "ws-error":
    case "released":
    case "orphaned":
    case "fatal":
      return { what: `port ${msg.kind}`, detail: url };
  }
}

/** A nested mark: the step of a port message's handling it names. */
const step =
  (what: string): (() => TaskMarkText) =>
  () => ({ what, detail: "" });

/** The OS seams a socket's tab client and its worker host run on. */
interface WorkerSeams {
  makeSharedWorker: MakeSharedWorker;
  locks: LockManagerLike;
}

function realSharedWorker(name: string): SharedWorkerLike {
  // eslint-disable-next-line browser-floor/no-api-above-floor -- handed out only where `typeof SharedWorker` passed (below; Chrome Android has it from 148)
  return new SharedWorker(new URL("./shared-ws.worker.ts", import.meta.url), {
    type: "module",
    name,
  });
}

/** This page's in-page workers (one host per name), made on first need. */
let inPageSeams: WorkerSeams | null = null;

/**
 * Where this page's sockets live — the one capability check, so no consumer
 * makes its own. With SharedWorker AND Web Locks (the worker needs both: the
 * locks tell it a tab is gone): in a SharedWorker, one socket per URL shared by
 * every tab of the origin. Without one of them (Chrome for Android before 148,
 * Android System WebView — Instagram's in-app browser): the same worker logic
 * run in this page (`in-page-ws-host.ts`), one socket per URL per page, with
 * the same behaviour for every consumer.
 */
function defaultSeams(): WorkerSeams {
  const locks =
    typeof navigator !== "undefined"
      ? (navigator as Navigator & { locks?: LockManagerLike }).locks
      : undefined;
  if (typeof SharedWorker !== "undefined" && locks !== undefined) {
    return { makeSharedWorker: realSharedWorker, locks };
  }
  if (inPageSeams === null) {
    const inPageLocks = createInPageLocks();
    inPageSeams = {
      makeSharedWorker: createInPageSharedWorkers({
        // Past the page request guard: this socket IS the sanctioned channel.
        makeWebSocket: (url) => nativeWebSocket(url),
        locks: inPageLocks,
      }),
      locks: inPageLocks,
    };
  }
  return inPageSeams;
}

/**
 * A live tab the worker evicted (or restarted under) re-attaches — at most `MAX_EVICTIONS` times per
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
  /** The page's reach when the worker was asked for (web-sdk's page-reach). */
  reach: ReachMark;
}

// Drop-in replacement for the string-message subset of the native WebSocket
// API, shared across all tabs of the same origin: the real socket lives in a
// SharedWorker (one per URL per networking build), and every tab talks to it
// through a MessagePort. No tab owns the socket, so closing or freezing any tab
// never interrupts the others. In a browser without SharedWorker or Web Locks
// the same worker logic runs in the page (`defaultSeams`): a socket per page,
// everything else alike.
export class SharedWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readonly url: string;
  readyState: number = SharedWebSocket.CONNECTING;

  onopen: ((ev: Event) => void) | null = null;
  onmessage: ((msg: SocketMessage) => void) | null = null;
  onclose: ((ev: CloseEvent) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;

  private readonly absUrl: string;
  private readonly dialect: string | undefined;
  private readonly address: string | null;
  private readonly heartbeatMs: number | null;
  private readonly makeSharedWorker: MakeSharedWorker;
  private readonly locks: LockManagerLike;
  private readonly lifecycle: PageLifecycleLike | null;
  /** Ends the resume subscription (`heartbeatMs`); null when none. */
  private unsubscribeResume: (() => void) | null = null;
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
  /**
   * How many times this tab's worker failed to load after the page lost its
   * reach — part of the worker's name from then on (`onWorkerError`).
   */
  private relaunches = 0;

  constructor(
    url: string | URL,
    hooks?: SharedWebSocketHooks,
    options?: SharedWebSocketOptions,
  ) {
    this.url = typeof url === "string" ? url : url.toString();
    this.dialect = options?.dialect;
    this.address = options?.address ?? null;
    this.heartbeatMs = options?.heartbeatMs ?? null;
    this.makeSharedWorker =
      hooks?.makeSharedWorker ?? defaultSeams().makeSharedWorker;
    this.locks = hooks?.locks ?? defaultSeams().locks;
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
    if (this.heartbeatMs !== null) {
      const resume =
        hooks?.pageResume !== undefined ? hooks.pageResume : documentResume();
      this.unsubscribeResume =
        resume?.subscribe(() => {
          // Only to a worker that holds this tab's attach: a queued doubt
          // would be about a socket the resume never saw.
          if (this.session?.attached) {
            this.session.port.postMessage({
              kind: "check-link",
            } satisfies TabToWorker);
          }
        }) ?? null;
    }
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

  /**
   * The consumer showed the open connection `conn` does not carry its frames
   * to the server (a frame it sent went unread while the server, asked over
   * HTTP, answered at once): the worker replaces it if it is still the open
   * one (`SocketOwner.replaceConnection`, `ws-unread`), and the next open
   * replays the consumer's state on a connection that answers.
   */
  replaceConnection(conn: string): void {
    if (this.closed) return;
    // Only to a worker that holds this tab's attach: a queued request would
    // be about a connection the worker may no longer hold.
    if (this.session?.attached) {
      this.session.port.postMessage({
        kind: "replace-connection",
        conn,
      } satisfies TabToWorker);
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.readyState = SharedWebSocket.CLOSED;
    this.lifecycle?.removeEventListener("pagehide", this.onPageHide);
    this.lifecycle?.removeEventListener("pageshow", this.onPageShow);
    this.unsubscribeResume?.();
    this.unsubscribeResume = null;
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
    const name = sharedWsWorkerName(this.absUrl, this.dialect);
    const reach = markPageReach();
    const worker = this.makeSharedWorker(
      this.relaunches === 0 ? name : `${name}#relaunch-${this.relaunches}`,
    );
    const session: PortSession = {
      worker,
      port: worker.port,
      portId,
      attached: false,
      queue: [],
      releaseLock: null,
      lock: "held",
      reach,
    };
    this.session = session;
    // Both are entry points the browser calls: marked tasks, so a freeze
    // inside one names the message that started it (LoAF names only this
    // handler — "(anonymous) (MessagePort.onmessage)").
    worker.onerror = () =>
      runMarked(
        "networking",
        () => ({ what: "port worker-error", detail: this.url }),
        () => this.onWorkerError(session),
      );
    session.port.onmessage = (ev: MessageEvent<WorkerToTab>) =>
      runMarked(
        "networking",
        () => portMark(this.url, ev.data),
        () => this.onWorkerMessage(session, ev.data),
      );

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
            address: this.address,
            heartbeatMs: this.heartbeatMs,
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
            runMarked("networking", step("onopen"), () =>
              this.dispatch(() => this.onopen?.(new Event("open"))),
            );
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
          this.onmessage?.({ data: msg.data, arrivedAt: msg.arrivedAt }),
        );
        return;
      case "ws-error":
        runMarked("networking", step("onerror"), () =>
          this.dispatch(() => this.onerror?.(new Event("error"))),
        );
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
        this.reattach(
          () =>
            `the shared-ws worker evicted this live tab ${this.evictions.length} times in ${EVICTION_WINDOW_MS / 1000}s (tab lock: ${session.lock})`,
        );
        return;
      case "orphaned":
        // The worker restarted under this tab and was handed its port again
        // (WebKit relaunches a SharedWorker for its live clients): the new
        // instance never heard this port's attach, so it serves nothing on it.
        // The socket it owned died with the old instance — attach again, and
        // `onopen` on the new connection replays the consumers' state.
        publishNetDiag({
          type: "port-orphaned",
          url: this.absUrl,
          first: msg.first,
        });
        this.reattach(
          () =>
            `the shared-ws worker restarted under this tab ${this.evictions.length} times in ${EVICTION_WINDOW_MS / 1000}s`,
        );
        return;
      case "fatal":
        this.detach();
        this.setStatus("closed");
        throw new Error(`SharedWebSocket ${this.url}: ${msg.message}`);
    }
  }

  /**
   * The worker dropped this live tab's port (evicted it, or restarted and no
   * longer knows it): attach again on a fresh port — at most `MAX_EVICTIONS`
   * times per `EVICTION_WINDOW_MS`. One more and the cause is not transient:
   * re-attaching would only spin, so it stops and fails loudly (`why`).
   */
  private reattach(why: () => string): void {
    runMarked("networking", step("detach"), () => this.detach());
    const now = Date.now();
    this.evictions = this.evictions.filter((t) => now - t < EVICTION_WINDOW_MS);
    this.evictions.push(now);
    if (this.evictions.length > MAX_EVICTIONS) {
      this.setStatus("closed");
      throw new Error(`SharedWebSocket ${this.url}: ${why()} — giving up`);
    }
    this.boundConn = null;
    this.readyState = SharedWebSocket.CONNECTING;
    runMarked("networking", step("attach"), () => this.attach());
  }

  /**
   * The worker failed to load or crashed. After the page lost its reach while
   * it loaded — a sleep, mostly: a laptop closed while the page booted, and
   * the worker script's request died with its connection — that is the
   * visitor's network, not ours: attach again once the page is back (equin.ai
   * /foundations, Firefox, report-1795099021-ohg6bc; the edge saw the page
   * stop mid-load and resume 39 minutes later, the worker script never asked
   * for). A failure while the page kept its reach stays loud.
   *
   * The new attach names its worker afresh (`#relaunch-<n>`): Firefox hands a
   * SharedWorker made with the failed one's name within a few ms of the error
   * to the dying instance, which never loads, errors or answers (measured in
   * Playwright's Firefox 159: the same name hangs at 0–1 ms, starts from 5 ms
   * on; another name starts at once). Tabs that woke from the same sleep each
   * relaunch once, so they still share `#relaunch-1`'s socket.
   */
  private onWorkerError(session: PortSession): void {
    if (session !== this.session) return;
    this.detach();
    if (pageReachLostSince(session.reach)) {
      console.warn(
        `SharedWebSocket ${this.url}: the shared-ws worker failed to load while the page was hidden, offline, asleep or leaving — attaching again once the page is back`,
      );
      this.relaunches++;
      this.boundConn = null;
      this.readyState = SharedWebSocket.CONNECTING;
      this.setStatus("connecting");
      void whenPageCanFetch().then(() => {
        if (this.closed || this.session !== null) return;
        runMarked("networking", step("attach"), () => this.attach());
      });
      return;
    }
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
