// SharedWorker entry: the out-of-thread watchdog for every tab of this origin
// (one per build — its identity is this script's content-addressed URL plus
// WATCHDOG_WORKER_NAME). A frozen tab cannot report itself, so this thread pings
// each tab at 1 Hz and notices the silence. Built by vite as its own
// self-contained chunk: import maps do not reach workers, so it imports only
// this plugin's own files (the web-artifacts inline audit enforces it).
//
// The 1 Hz ping timer is a sanctioned exception to "no polling": detecting the
// ABSENCE of a signal needs a clock (like the server health monitor's event-loop
// sampler). It runs only while a visible tab is attached or a stall is in
// flight (needsClock).

import { STALL, portLockName, workerLockName } from "./internal/constants";
import type { TabToWorker, WorkerToTab } from "./internal/protocol";
import {
  createStallMachine,
  needsClock,
  step,
  type StallEffect,
  type StallEvent,
} from "./internal/stall-machine";
import { openStallStore, type StallStore } from "./internal/stall-store";

interface PortLike {
  postMessage(msg: WorkerToTab): void;
  onmessage: ((ev: MessageEvent<TabToWorker>) => void) | null;
  close(): void;
}

const scope = globalThis as unknown as {
  onconnect: ((ev: { ports: readonly PortLike[] }) => void) | null;
};

function boot(): void {
  const locks = (navigator as Navigator & { locks?: LockManager }).locks;
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- absent in engines without Web Locks in workers
  if (!locks) {
    throw new Error(
      "main-thread-stall watchdog: navigator.locks is unavailable in this SharedWorker — tab liveness cannot be tracked",
    );
  }
  const workerId = crypto.randomUUID();
  const machine = createStallMachine({
    workerId,
    newId: () => crypto.randomUUID(),
  });
  const ports = new Map<string, PortLike>();
  let timer: ReturnType<typeof setInterval> | null = null;
  const storeReady: Promise<StallStore> = openStallStore(indexedDB);

  const fatal = (err: unknown): void => {
    const message = `main-thread-stall watchdog: ${err instanceof Error ? err.message : String(err)}`;
    for (const p of ports.values()) p.postMessage({ kind: "fatal", message });
  };

  const apply = (effects: StallEffect[]): void => {
    for (const e of effects) {
      switch (e.type) {
        case "ping":
          for (const id of e.portIds)
            ports.get(id)?.postMessage({ kind: "ping" });
          break;
        case "persist":
          void storeReady.then((s) => s.put(e.record)).catch(fatal);
          break;
        case "forget":
          void storeReady.then((s) => s.delete(e.id)).catch(fatal);
          break;
        case "deliver":
          ports
            .get(e.portId)
            ?.postMessage({ kind: "file", id: e.id, payload: e.payload });
          break;
        case "log": {
          // Via an answering tab — the worker has no log channel of its own.
          // None answering: the line waits in a frozen tab's queue (it is
          // read if that tab recovers).
          const [first] = ports.values();
          const carrier = (e.portId ? ports.get(e.portId) : undefined) ?? first;
          carrier?.postMessage({ kind: "log", line: e.line });
          break;
        }
      }
    }
  };

  const feed = (ev: StallEvent): void => {
    apply(step(machine, ev));
    syncClock();
  };

  function syncClock(): void {
    const want = needsClock(machine);
    if (want && timer === null) {
      timer = setInterval(
        () => feed({ type: "tick", now: Date.now() }),
        STALL.PING_MS,
      );
    } else if (!want && timer !== null) {
      clearInterval(timer);
      timer = null;
      apply(step(machine, { type: "clock-stopped" }));
    }
  }

  // Held for this worker's whole life: while held, its stored stalls are its
  // own; once free (the worker died), the next watchdog adopts them.
  void locks.request(
    workerLockName(workerId),
    () => new Promise<void>(() => {}),
  );

  // Adopt the stalls a dead watchdog left behind (it died with a stall open,
  // or before a tab could file a finished one). Taking the dead owner's lock
  // while adopting means two booting watchdogs cannot both adopt one record.
  void storeReady
    .then(async (store) => {
      for (const rec of await store.all()) {
        if (rec.owner === workerId) continue;
        await locks.request(
          workerLockName(rec.owner),
          { ifAvailable: true },
          async (lock) => {
            if (lock === null) return; // its owner is alive
            const current = await store.get(rec.id);
            if (current && current.owner === rec.owner)
              feed({ type: "adopt", record: current });
          },
        );
      }
    })
    .catch(fatal);

  scope.onconnect = (ev) => {
    for (const port of ev.ports) {
      let portId: string | null = null;
      port.onmessage = (msg) => {
        const m = msg.data;
        const now = Date.now();
        if (m.kind === "attach") {
          if (m.proto !== STALL.PROTO) {
            port.postMessage({
              kind: "fatal",
              message: `main-thread-stall watchdog: protocol ${m.proto} ≠ ${STALL.PROTO}`,
            });
            port.close();
            return;
          }
          const id = m.portId;
          portId = id;
          ports.set(id, port);
          port.postMessage({ kind: "hello", workerId });
          feed({
            type: "attach",
            portId: id,
            tab: m.tab,
            frozen: m.frozen,
            now,
          });
          // Queued behind the tab's own hold of this lock: granted ⇒ the tab is
          // gone (reloaded, closed, killed) — the one liveness signal a
          // SharedWorker gets, and the one a frozen tab still passes.
          void locks.request(portLockName(id), () => {
            if (ports.get(id) === port) {
              ports.delete(id);
              feed({ type: "gone", portId: id, now: Date.now() });
            }
          });
          return;
        }
        if (portId === null) return;
        switch (m.kind) {
          case "pong":
            feed({ type: "pong", portId, now });
            return;
          case "state":
            feed({ type: "state", portId, tab: m.tab, frozen: m.frozen, now });
            return;
          case "frame":
            feed({ type: "frame", portId, frame: m.frame, now });
            return;
          case "filed":
            feed({ type: "filed", id: m.id, ok: m.ok });
            return;
          case "detach":
            ports.delete(portId);
            feed({ type: "gone", portId, now });
            port.close();
            return;
        }
      };
    }
  };
}

boot();
