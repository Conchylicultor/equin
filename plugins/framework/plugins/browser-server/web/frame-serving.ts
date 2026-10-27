// Frame serving, the page's half: register a browser host's frame-serving
// Service Worker (`frames-sw.ts`), wait for it to be active, and hand it a
// port the host's worker answers on — so a frame document of that server
// loads by URL (`Transport.frameBase`). The page itself stays outside the
// scope, never controlled: only frame documents reach the Service Worker.

import { attachPort, type PortEnd } from "../core";
import {
  framesScope,
  isFramesScope,
  type FromFramesSw,
  type ToFramesSw,
} from "./frames-protocol";

/** Whether a browser server's frames can be served by URL here. */
export type FrameServing =
  | {
      kind: "serving";
      /** `Transport.frameBase`: the path prefix in front of the server's `/api/…` paths. */
      frameBase: string;
      /** The server is gone: the Service Worker drops its port, and the page stops answering for it. */
      detach(): void;
    }
  | {
      kind: "unsupported";
      /** Why (no Service Worker in this browser or context). */
      reason: string;
    };

/**
 * Serve the frames of the server in `worker` (a `Worker` running
 * `serveOverPort`) through the Service Worker at `serviceWorkerUrl` (its
 * host module's `serviceWorkerUrl`): registered on its scope and awaited
 * until `activated` (never `navigator.serviceWorker.ready`, which waits for a
 * worker controlling THIS page — it never will), then handed one end of a
 * channel whose other end the server answers on, under a fresh server id —
 * and a fresh one again whenever the Service Worker, restarted, asks.
 * Registrations an earlier build left (`/artifacts/<dir>/frames/`) are
 * dropped once no tab serves through them: each serving page holds a shared
 * Web Lock named by its scope until it detaches (or closes), so a tab still
 * running an older build keeps its frames. Runs alongside the host's boot: the
 * worker queues the port's requests until its graph is up.
 *
 * `unsupported` where this browser or context has no Service Worker (an
 * insecure origin, a private window that refuses registration, an automated
 * browser that blocks it).
 */
export async function attachFrameServing(
  worker: PortEnd,
  serviceWorkerUrl: string,
): Promise<FrameServing> {
  if (!("serviceWorker" in navigator)) {
    return {
      kind: "unsupported",
      reason: "this browser offers no Service Worker here",
    };
  }
  const scope = framesScope(serviceWorkerUrl);
  // Held before the registration exists, so no other tab's GC can drop it
  // between its registration and its first frame.
  const releaseScope = await holdScope(scope);
  let serving: FrameServing;
  try {
    serving = await serveUnder(worker, serviceWorkerUrl, scope, releaseScope);
  } catch (err) {
    releaseScope();
    throw err;
  }
  if (serving.kind === "unsupported") releaseScope();
  return serving;
}

/** `attachFrameServing` under `scope`, its lock held (`releaseScope` drops it on detach). */
async function serveUnder(
  worker: PortEnd,
  serviceWorkerUrl: string,
  scope: string,
  releaseScope: () => void,
): Promise<FrameServing> {
  const container = navigator.serviceWorker;
  // Typed wider than the DOM's: a context that blocks Service Workers by
  // replacing `register` (Playwright's `serviceWorkers: "block"` — the agent
  // browser, the thumbnail renderer) resolves it with nothing at all.
  let registration: ServiceWorkerRegistration | undefined;
  try {
    registration = await container.register(serviceWorkerUrl, { scope });
  } catch (err) {
    // A context that refuses Service Workers (Firefox private windows).
    if (err instanceof DOMException && err.name === "SecurityError") {
      return { kind: "unsupported", reason: err.message };
    }
    throw err;
  }
  if (registration === undefined) {
    return {
      kind: "unsupported",
      reason: "this context blocks Service Worker registration",
    };
  }
  const active = await activated(registration);
  await dropStaleScopes(container, scope);

  const serverId = globalThis.crypto.randomUUID();
  const post = (msg: ToFramesSw, transfer: Transferable[] = []) =>
    active.postMessage(msg, transfer);
  const handPort = () => {
    const channel = new MessageChannel();
    attachPort(worker, channel.port1);
    post({ t: "attach", serverId, port: channel.port2 }, [channel.port2]);
  };
  const onMessage = (event: MessageEvent<FromFramesSw>) => {
    // `need-port`, the one thing a Service Worker asks; for this server only.
    if (event.data.serverId === serverId) handPort();
  };
  container.addEventListener("message", onMessage);
  // Messages to a page's container wait for this (or an `onmessage`).
  container.startMessages();
  handPort();
  return {
    kind: "serving",
    frameBase: `${new URL(scope).pathname}${serverId}`,
    detach() {
      container.removeEventListener("message", onMessage);
      post({ t: "detach", serverId });
      releaseScope();
    },
  };
}

/** The registration's worker, once `activated`; throws when it turns redundant (its script failed). */
async function activated(
  registration: ServiceWorkerRegistration,
): Promise<ServiceWorker> {
  const worker =
    registration.active ?? registration.waiting ?? registration.installing;
  if (worker === null) {
    throw new Error(
      `frame serving: the registration at ${registration.scope} has no worker`,
    );
  }
  if (worker.state === "activated") return worker;
  return new Promise<ServiceWorker>((resolve, reject) => {
    const onChange = () => {
      if (worker.state === "activated") {
        worker.removeEventListener("statechange", onChange);
        resolve(worker);
      } else if (worker.state === "redundant") {
        worker.removeEventListener("statechange", onChange);
        reject(
          new Error(
            `frame serving: the Service Worker at ${worker.scriptURL} failed to install`,
          ),
        );
      }
    };
    worker.addEventListener("statechange", onChange);
  });
}

/** The Web Lock a page serving frames through `scope` holds. */
const scopeLockName = (scope: string): string => `frames-scope ${scope}`;

/**
 * Hold `scope`'s lock, shared, until the returned release: what tells another
 * tab's {@link dropStaleScopes} this scope is still in use. Resolves once held,
 * so a page serves only under a scope no GC can miss. Without Web Locks (a test
 * DOM — every browser offering Service Workers offers them) there is nothing to
 * hold, and no GC runs either.
 */
async function holdScope(scope: string): Promise<() => void> {
  if (!("locks" in navigator)) return () => undefined;
  return new Promise<() => void>((held) => {
    void navigator.locks.request(
      scopeLockName(scope),
      { mode: "shared" },
      () => new Promise<void>((release) => held(release)),
    );
  });
}

/**
 * Unregister every frame-serving scope but `current` that no tab holds — each
 * build has its own scope (its artifact dir is content-addressed), and a tab
 * still on an older build serves its frames through that build's. Skipped
 * without Web Locks: who still uses a scope cannot be known, and a dormant
 * registration costs less than a tab whose frames stop loading.
 */
async function dropStaleScopes(
  container: ServiceWorkerContainer,
  current: string,
): Promise<void> {
  if (!("locks" in navigator)) return;
  const locks = await navigator.locks.query();
  const inUse = new Set(
    [...(locks.held ?? []), ...(locks.pending ?? [])].map((l) => l.name),
  );
  const registrations = await container.getRegistrations();
  await Promise.all(
    registrations
      .filter(
        (r) =>
          r.scope !== current &&
          isFramesScope(r.scope) &&
          !inUse.has(scopeLockName(r.scope)),
      )
      .map((r) => r.unregister()),
  );
}
