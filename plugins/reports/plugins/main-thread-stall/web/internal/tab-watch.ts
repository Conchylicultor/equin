import { LEGACY_IDS } from "@plugins/framework/plugins/product-name/core";
import { clientLog } from "@plugins/primitives/plugins/log-channels/web";
import {
  onTaskMark,
  runMarked,
} from "@plugins/primitives/plugins/perfs/plugins/task-marks/web";
import type { StallFrame, StallTab } from "../../core";
import {
  STALL,
  portLockName,
  watchdogWorkerName,
  workerLockName,
} from "./constants";
import type { TabToWorker, WorkerToTab } from "./protocol";
import { fileSlowFrame, fileStall } from "./file-stall";
import { installInTabFallback } from "./in-tab-fallback";
import type { InteractionBegin } from "./interaction-judge";
import { installInteractionWatch } from "./interaction-watch";
import {
  LOAF_ENTRY_TYPE,
  loafSupported,
  toStallFrame,
  type LoafEntry,
} from "./loaf";
import { LOG_CHANNEL } from "./log-channel";

// The prefix of every browser-visible name the watchdog takes; the worker reads
// it back from the name it is started under (see constants.ts).
const PREFIX = LEGACY_IDS.browserKeyPrefix;

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
        void navigator.locks.request(
          workerLockName(PREFIX, msg.workerId),
          () => {
            if (s !== session) return;
            clientLog(
              LOG_CHANNEL,
              JSON.stringify({ kind: "watchdog-lost", workerId: msg.workerId }),
            );
            detach();
            if (!disposed) attach();
          },
        );
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
      { type: "module", name: watchdogWorkerName(PREFIX) },
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
    // Marked like any entry point: LoAF has blamed this very handler for a
    // freeze (106 s, 2026-11-06) — if the detector's own work ever freezes a
    // tab, its report names the message.
    worker.port.onmessage = (ev: MessageEvent<WorkerToTab>) =>
      runMarked(
        "main-thread-stall",
        () => ({ what: ev.data.kind, detail: "" }),
        () => onWorkerMessage(s, ev.data),
      );
    // Hold the port's liveness lock for its whole life and attach only once it
    // is held: the worker queues for the same lock, so its grant means "gone".
    void navigator.locks.request(
      portLockName(PREFIX, s.portId),
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

  // Every marked task's begin and end go to the watchdog as they happen:
  // postMessage hands them to the worker's thread at once, so a task that
  // freezes this thread leaves its mark open there. Only while attached (never
  // queued — a mark is worth something only at the instant it is sent) and
  // visible (a hidden tab's stall is never reported); an end is sent only for
  // a begin that was, carrying its id.
  const capText = (t: string): string =>
    t.length > STALL.STRING_CAP ? `${t.slice(0, STALL.STRING_CAP)}…` : t;
  let markId = 0;
  const uninstallMarks = useWorker
    ? onTaskMark({
        begin(source, describe) {
          const s = session;
          if (!s?.attached || document.visibilityState !== "visible")
            return null;
          const id = ++markId;
          const at = Date.now();
          const { what, detail } = describe();
          s.worker.port.postMessage({
            kind: "mark",
            id,
            mark: { at, source, what: capText(what), detail: capText(detail) },
          } satisfies TabToWorker);
          return id;
        },
        // Sent even if the tab went hidden meanwhile: a begun mark must end.
        // A new session's port never saw the begin — the worker ignores it.
        end(id) {
          const s = session;
          if (id !== null && s?.attached)
            s.worker.port.postMessage({
              kind: "mark-end",
              id,
            } satisfies TabToWorker);
        },
      })
    : null;

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

  // Every user interaction goes to the watchdog at dispatch, before its
  // handlers run, and is closed after its next paint: a stall that opens
  // while one is unpainted started from it, and its report names the control
  // (the frozen tab could not say so later). Like marks: only while attached
  // and visible, never queued; an end only for a begin that was sent.
  let interactionId = 0;
  const onInteraction = (begin: InteractionBegin): void => {
    const s = session;
    if (!s?.attached || document.visibilityState !== "visible") return;
    const id = ++interactionId;
    s.worker.port.postMessage({
      kind: "interaction",
      id,
      interaction: begin,
    } satisfies TabToWorker);
    afterNextPaint(() => {
      if (s === session)
        s.worker.port.postMessage({
          kind: "interaction-end",
          id,
        } satisfies TabToWorker);
    });
  };

  // Slow interactions (input → next paint): fed every long frame for their
  // attribution, and the owner of any 1–5 s frame one overlaps.
  const interactions = installInteractionWatch(
    readTab,
    useWorker ? onInteraction : () => {},
  );

  let observer: PerformanceObserver | null = null;
  if (loafSupported()) {
    observer = new PerformanceObserver((list) => {
      for (const e of list.getEntries() as LoafEntry[]) {
        interactions.onFrame(e);
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
      // A slow interaction overlapping it owns it (it names what was clicked);
      // otherwise it is the app + route's `main-thread` slow-op.
      interactions.deferSlowFrame(frame, () => fileSlowFrame(frame, tab));
    fallback?.onFrame(frame, tab, () => interactions.beganIn(frame));
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
      uninstallMarks?.();
      observer?.disconnect();
      interactions.dispose();
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

/**
 * Run `fn` once the next frame has painted: the first task after the
 * rendering step that follows the next animation frame callback. One-shot.
 */
function afterNextPaint(fn: () => void): void {
  requestAnimationFrame(() => {
    const ch = new MessageChannel();
    ch.port1.onmessage = () => {
      ch.port1.close();
      fn();
    };
    ch.port2.postMessage(null);
  });
}
