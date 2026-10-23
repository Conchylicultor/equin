import { clientLog } from "@plugins/primitives/plugins/log-channels/web";
import type { StallFrame, StallTab } from "../../core";
import {
  STALL,
  WATCHDOG_WORKER_NAME,
  portLockName,
  workerLockName,
} from "./constants";
import type { TabToWorker, WorkerToTab } from "./protocol";
import { fileSlowFrame, fileStall } from "./file-stall";
import { installInTabFallback } from "./in-tab-fallback";
import {
  LOAF_ENTRY_TYPE,
  loafSupported,
  toStallFrame,
  type LoafEntry,
} from "./loaf";
import { LOG_CHANNEL } from "./log-channel";

/** One attachment of this tab to the watchdog: a port plus its liveness lock. */
interface Session {
  worker: SharedWorker;
  portId: string;
  attached: boolean;
  queue: TabToWorker[];
  releaseLock: (() => void) | null;
}

export interface StallWatch {
  /** The tab's app or route changed: tell the watchdog where it is now. */
  refresh(): void;
  dispose(): void;
}

/**
 * The tab half of the main-thread stall detector: answers the watchdog's
 * pings, keeps it told where this tab is (app, route, visibility, focus, Page
 * Lifecycle freeze), posts long frames with their LoAF attribution, and files
 * the finished stalls the watchdog hands it. Without SharedWorker it runs the
 * in-tab fallback instead.
 */
export function installStallWatch(readTab: () => StallTab): StallWatch {
  let frozen = false;
  let session: Session | null = null;
  let disposed = false;
  const useWorker = typeof SharedWorker !== "undefined" && "locks" in navigator;
  const fallback = useWorker ? null : installInTabFallback(readTab);
  if (!useWorker) {
    clientLog(
      LOG_CHANNEL,
      JSON.stringify({
        kind: "fallback",
        reason: "no SharedWorker / Web Locks",
      }),
    );
  }

  const post = (msg: TabToWorker): void => {
    const s = session;
    if (!s) return;
    if (s.attached) s.worker.port.postMessage(msg);
    else s.queue.push(msg);
  };

  const onWorkerMessage = (s: Session, msg: WorkerToTab): void => {
    if (s !== session) return;
    switch (msg.kind) {
      case "hello":
        // The watchdog runs inside some tab's renderer and dies with it (a
        // hung renderer Chrome kills, a crash). Its lifetime lock frees then:
        // re-attach, which starts a fresh watchdog that adopts what it left.
        void navigator.locks.request(workerLockName(msg.workerId), () => {
          if (s !== session) return;
          clientLog(
            LOG_CHANNEL,
            JSON.stringify({ kind: "watchdog-lost", workerId: msg.workerId }),
          );
          detach();
          if (!disposed) attach();
        });
        return;
      case "ping":
        post({ kind: "pong" });
        return;
      case "file":
        void fileStall(msg.payload).then((ok) => {
          if (s === session) post({ kind: "filed", id: msg.id, ok });
        });
        return;
      case "log":
        clientLog(LOG_CHANNEL, JSON.stringify(msg.line));
        return;
      case "fatal":
        detach();
        throw new Error(msg.message);
    }
  };

  function attach(): void {
    const worker = new SharedWorker(
      new URL("../stall-watchdog.worker.ts", import.meta.url),
      { type: "module", name: WATCHDOG_WORKER_NAME },
    );
    const s: Session = {
      worker,
      portId: crypto.randomUUID(),
      attached: false,
      queue: [],
      releaseLock: null,
    };
    session = s;
    worker.onerror = () => {
      if (s !== session) return;
      detach();
      throw new Error(
        "main-thread-stall: the watchdog SharedWorker failed to load or crashed",
      );
    };
    worker.port.onmessage = (ev: MessageEvent<WorkerToTab>) =>
      onWorkerMessage(s, ev.data);
    // Hold the port's liveness lock for its whole life and attach only once it
    // is held: the worker queues for the same lock, so its grant means "gone".
    void navigator.locks.request(
      portLockName(s.portId),
      { mode: "exclusive" },
      () =>
        new Promise<void>((resolve) => {
          if (s !== session) {
            resolve();
            return;
          }
          s.releaseLock = resolve;
          s.worker.port.postMessage({
            kind: "attach",
            proto: STALL.PROTO,
            portId: s.portId,
            tab: readTab(),
            frozen,
          } satisfies TabToWorker);
          s.attached = true;
          for (const m of s.queue.splice(0)) s.worker.port.postMessage(m);
        }),
    );
  }

  function detach(): void {
    const s = session;
    if (!s) return;
    session = null;
    if (s.attached)
      s.worker.port.postMessage({ kind: "detach" } satisfies TabToWorker);
    s.worker.port.onmessage = null;
    s.worker.onerror = null;
    s.worker.port.close();
    s.releaseLock?.();
  }

  const postState = (): void => post({ kind: "state", tab: readTab(), frozen });
  const onFreeze = (): void => {
    frozen = true;
    postState();
  };
  const onResume = (): void => {
    frozen = false;
    postState();
  };
  // A page entering the bfcache is frozen with its port still open: always
  // detach on pagehide, re-attach on a bfcache restore.
  const onPageHide = (): void => detach();
  const onPageShow = (ev: PageTransitionEvent): void => {
    if (ev.persisted && !session && !disposed && useWorker) attach();
  };

  let observer: PerformanceObserver | null = null;
  if (loafSupported()) {
    observer = new PerformanceObserver((list) => {
      for (const e of list.getEntries() as LoafEntry[]) {
        if (e.duration < STALL.FRAME_POST_MIN_MS) continue;
        onFrame(toStallFrame(e));
      }
    });
    observer.observe({ type: LOAF_ENTRY_TYPE, buffered: false });
  } else {
    clientLog(
      LOG_CHANNEL,
      JSON.stringify({
        kind: "no-loaf",
        reason: "long-animation-frame unsupported: stalls go unattributed",
      }),
    );
  }

  function onFrame(frame: StallFrame): void {
    const tab = readTab();
    post({ kind: "frame", frame });
    if (!tab.visible) return;
    if (
      frame.durationMs >= STALL.SLOW_OP_MIN_MS &&
      frame.durationMs < STALL.REPORT_MIN_MS
    )
      fileSlowFrame(frame, tab);
    fallback?.onFrame(frame, tab);
  }

  if (useWorker) {
    attach();
    document.addEventListener("visibilitychange", postState);
    window.addEventListener("focus", postState);
    window.addEventListener("blur", postState);
    document.addEventListener("freeze", onFreeze);
    document.addEventListener("resume", onResume);
    window.addEventListener("pagehide", onPageHide);
    window.addEventListener("pageshow", onPageShow);
  }

  return {
    refresh: postState,
    dispose() {
      disposed = true;
      observer?.disconnect();
      fallback?.dispose();
      detach();
      document.removeEventListener("visibilitychange", postState);
      window.removeEventListener("focus", postState);
      window.removeEventListener("blur", postState);
      document.removeEventListener("freeze", onFreeze);
      document.removeEventListener("resume", onResume);
      window.removeEventListener("pagehide", onPageHide);
      window.removeEventListener("pageshow", onPageShow);
    },
  };
}
