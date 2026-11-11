// ── Connecting to a SharedWorker host that may be retiring ──────────────────
//
// A SharedWorker host outlives its last tab (`extendedLifetime`) so what that
// tab asked for is finished and flushed, then closes itself (`serveHost`'s
// `retire`). But Chromium matches a `new SharedWorker(url, name)` against a
// worker until the browser process has heard of its close: a page connecting
// in that window is handed the dying worker and waits for good — no message,
// no error, no port `close` event (measured: a connect ~0 ms after `close()`).
// That window cannot be detected from the page, so it is made unreachable:
//
// - a page connects to `name` only while holding the lock
//   `retireLockName(name)` SHARED, asked `ifAvailable`, and keeps it until the
//   worker's `accepted` — the worker has taken its end in;
// - the worker retires only while holding that lock EXCLUSIVELY, with no end.
//
// So a connection is either one of the worker's ends before it decides, or
// made by a page that found the lock taken — which skips the name
// (`passed`) and connects to the next one the caller gives.

import type { FromHost, ToHost } from "./port";

/** The Web Lock a SharedWorker host named `workerName` retires under. */
export function retireLockName(workerName: string): string {
  return `equin-host-retire:${workerName}`;
}

/** This page's connection to a SharedWorker host. */
export interface SharedHostConnection {
  /** The worker name it connected to (not one skipped as retiring). */
  name: string;
  /**
   * The page's end, NOT started: the caller starts it once it listens
   * (`portBrowserServer`), so nothing the host posts is lost.
   */
  port: MessagePort;
  /** This page is done with the host (it may retire once no page holds it): closes the port. */
  leave(): void;
}

/**
 * Connect to the SharedWorker host named `name()` (`open` constructs it) —
 * never to one that is retiring: such a name is handed to `passed`, which must
 * move `name()` on (the demo: the next host generation), and the next one is
 * tried. The connection tells the host when this page goes away: it holds a
 * Web Lock for it until `leave` (or the tab is gone) and names it to the host
 * (`hello`), so a host with no page left can retire.
 *
 * Without Web Locks (a test realm) there is nothing to hold: it connects to
 * `name()` as is.
 */
export async function connectSharedHost(opts: {
  open: (name: string) => SharedWorker;
  name: () => string;
  passed: (name: string) => void;
}): Promise<SharedHostConnection> {
  if (typeof navigator === "undefined" || navigator.locks === undefined) {
    const name = opts.name();
    const port = opts.open(name).port;
    return { name, port, leave: () => port.close() };
  }
  for (;;) {
    const name = opts.name();
    const connection = await connectUnlessRetiring(opts.open, name);
    if (connection !== null) return connection;
    opts.passed(name);
    if (opts.name() === name) {
      throw new Error(
        `[browser-server] the host "${name}" is retiring, and passing it gave the same name again`,
      );
    }
  }
}

/** Connect to `name` while its retire lock is free, holding it until `accepted`; `null` when taken. */
function connectUnlessRetiring(
  open: (name: string) => SharedWorker,
  name: string,
): Promise<SharedHostConnection | null> {
  return new Promise((resolve, reject) => {
    navigator.locks
      .request(
        retireLockName(name),
        { mode: "shared", ifAvailable: true },
        (lock) => {
          if (lock === null) {
            resolve(null);
            return;
          }
          // Held until the host has taken this end in, or this page leaves
          // before it did (a head start never claimed).
          return new Promise<void>((release) => {
            const presence = `equin-port:${globalThis.crypto.randomUUID()}`;
            let gone!: () => void;
            const held = new Promise<void>((r) => (gone = r));
            void navigator.locks.request(
              presence,
              { mode: "exclusive" },
              () => held,
            );
            const port = open(name).port;
            const onMessage = (event: MessageEvent): void => {
              if ((event.data as FromHost).t !== "accepted") return;
              port.removeEventListener("message", onMessage);
              release();
            };
            port.addEventListener("message", onMessage);
            // An unstarted port posts all the same: the host learns of this
            // page at once, whenever the caller starts listening.
            port.postMessage({ t: "hello", lock: presence } satisfies ToHost);
            resolve({
              name,
              port,
              leave() {
                port.removeEventListener("message", onMessage);
                release();
                gone();
                port.close();
              },
            });
          });
        },
      )
      .catch(reject);
  });
}
