// SharedWorker entry: one instance per (this script's URL, worker name), i.e.
// per server URL per networking build. Built by vite as its own self-contained
// chunk (`new SharedWorker(new URL(...), …)` in `shared-websocket.ts`); import
// maps do not reach workers, so it inlines everything it imports — its closure
// is part of the artifact's address (web-artifacts' `own-files.ts`).

import { createSharedWsHost } from "./shared-ws-host";
import type { LockManagerLike, MessagePortLike } from "./transport-types";

const scope = globalThis as unknown as {
  onconnect: ((ev: { ports: readonly MessagePortLike[] }) => void) | null;
};

const locks = (navigator as Navigator & { locks?: LockManagerLike }).locks;
// eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- absent in engines without Web Locks in workers
if (!locks) {
  throw new Error(
    "shared-ws worker: navigator.locks is unavailable in this SharedWorker — " +
      "tab liveness cannot be tracked",
  );
}

const host = createSharedWsHost({
  makeWebSocket: (url) => new WebSocket(url),
  locks,
});

scope.onconnect = (ev) => {
  for (const port of ev.ports) host.connect(port);
};
