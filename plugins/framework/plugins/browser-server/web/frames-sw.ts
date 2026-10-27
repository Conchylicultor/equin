// Service Worker entry: serves a browser server's responses to FRAME
// documents, so an <iframe> loads a server's `/api/…` document by a real URL
// and its relative sub-resources (`styles.css`, a CSS `url()`) resolve beside
// it. Built by web-artifacts as a classic script into every browser host's
// artifact dir (`browser-hosts.ts`: `frames-sw.js`, exported as the host
// module's `serviceWorkerUrl`); import maps do not reach it, so it bundles
// whole and imports only this plugin's own files. The page registers it
// (`frame-serving.ts`) and is never controlled by it: only the documents
// navigated under its scope, and what they request, reach it.
//
// One frame URL is `<scope><serverId>/api/…` (`frames-protocol.ts`). Each
// server id maps to a port its worker answers on (`attachPort`); a Service
// Worker restarted from idle has lost them, so it asks every page for a fresh
// one and answers a loud 503 when no page owns the id within
// `FRAMES_PORT_WAIT_MS`. GET and HEAD only; a cross-origin request passes
// through untouched.

import { portRequester } from "../core";
import {
  FRAMES_PORT_WAIT_MS,
  REQUEST_BASE,
  routeFrameRequest,
  type FromFramesSw,
  type ToFramesSw,
} from "./frames-protocol";

// The repo's one lib types `self` as a Window: the part of a Service Worker's
// global scope this script uses, stated here.
interface ExtendableEventLike extends Event {
  waitUntil(promise: Promise<unknown>): void;
}
interface FetchEventLike extends Event {
  readonly request: Request;
  respondWith(response: Promise<Response> | Response): void;
}
interface ServiceWorkerScopeLike {
  readonly registration: { readonly scope: string };
  readonly location: { readonly origin: string };
  readonly clients: {
    matchAll(options: {
      type: "window";
      includeUncontrolled: boolean;
    }): Promise<readonly { postMessage(message: FromFramesSw): void }[]>;
  };
  skipWaiting(): Promise<void>;
  addEventListener(
    type: "install",
    listener: (event: ExtendableEventLike) => void,
  ): void;
  addEventListener(
    type: "fetch",
    listener: (event: FetchEventLike) => void,
  ): void;
  addEventListener(
    type: "message",
    listener: (event: MessageEvent<ToFramesSw>) => void,
  ): void;
}

const sw = globalThis as unknown as ServiceWorkerScopeLike;
const scopePath = new URL(sw.registration.scope).pathname;

type Requester = (req: Request) => Promise<Response>;

/** Each attached server's requester, by server id. */
const servers = new Map<string, { port: MessagePort; request: Requester }>();
/**
 * The one open ask for a server's port, by server id: every request finding no
 * port joins it, so a revived Service Worker hit by several frames at once asks
 * the page once and gets one port — never a second one replacing the first
 * while requests are in flight on it.
 */
const asking = new Map<
  string,
  { wake: (request: Requester) => void; answered: Promise<Requester | null> }
>();

// Each build's script has its own scope: nothing to wait for.
sw.addEventListener("install", (event) => {
  event.waitUntil(sw.skipWaiting());
});

sw.addEventListener("message", (event) => {
  const msg = event.data;
  switch (msg.t) {
    case "attach": {
      // A port already serves this id (a page answering an ask that timed out
      // just before): keep it — closing it would drop the answers of the
      // requests in flight on it — and let the newcomer go.
      if (servers.has(msg.serverId)) {
        msg.port.close();
        return;
      }
      const request = portRequester(msg.port);
      msg.port.start();
      servers.set(msg.serverId, { port: msg.port, request });
      asking.get(msg.serverId)?.wake(request);
      asking.delete(msg.serverId);
      return;
    }
    case "detach":
      servers.get(msg.serverId)?.port.close();
      servers.delete(msg.serverId);
      return;
  }
});

sw.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== sw.location.origin) return;
  const route = routeFrameRequest(scopePath, url.pathname);
  // Every same-origin request of a frame is answered here, so a frame's
  // absolute `/api` path never reaches the page's own server: outside its
  // server's URLs, it is a 404.
  if (route.kind === "not-found") {
    event.respondWith(
      page(404, `Not a URL of this frame's server: ${url.pathname}`),
    );
    return;
  }
  if (route.kind === "bad-path") {
    event.respondWith(
      page(400, `Refused path segment "${route.segment}" in ${url.pathname}`),
    );
    return;
  }
  const { method } = event.request;
  if (method !== "GET" && method !== "HEAD") {
    event.respondWith(
      page(405, `A frame URL answers GET and HEAD, not ${method}`),
    );
    return;
  }
  event.respondWith(
    serve(route.serverId, route.path + url.search, event.request),
  );
});

async function serve(
  serverId: string,
  path: string,
  original: Request,
): Promise<Response> {
  const request =
    servers.get(serverId)?.request ?? (await askForPort(serverId));
  if (request === null) {
    return page(
      503,
      "This frame's server is gone (its page was closed or reloaded) — reload the page.",
    );
  }
  // A HEAD is the GET's answer without its body: the server routes GETs.
  const res = await request(
    new Request(new URL(path, REQUEST_BASE), {
      method: "GET",
      headers: original.headers,
    }),
  );
  return original.method === "HEAD"
    ? new Response(null, {
        status: res.status,
        statusText: res.statusText,
        headers: res.headers,
      })
    : res;
}

/**
 * A port for `serverId` from the page that owns it — asked of every window of
 * this origin, uncontrolled ones included (the page never is controlled), once
 * per id however many requests wait — or `null` when none answers within
 * `FRAMES_PORT_WAIT_MS`.
 */
async function askForPort(serverId: string): Promise<Requester | null> {
  const open = asking.get(serverId);
  if (open !== undefined) return open.answered;
  let wake!: (request: Requester) => void;
  const answered = new Promise<Requester | null>((resolve) => {
    const timer = setTimeout(() => {
      asking.delete(serverId);
      resolve(null);
    }, FRAMES_PORT_WAIT_MS);
    wake = (request) => {
      clearTimeout(timer);
      resolve(request);
    };
  });
  asking.set(serverId, { wake, answered });
  const windows = await sw.clients.matchAll({
    type: "window",
    includeUncontrolled: true,
  });
  for (const client of windows)
    client.postMessage({ t: "need-port", serverId });
  return answered;
}

/** A plain HTML page saying what went wrong — a frame shows it as is. */
function page(status: number, message: string): Response {
  const text = message
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
  return new Response(
    `<!doctype html><meta charset="utf-8"><title>${String(status)}</title><p>${text}</p>`,
    { status, headers: { "Content-Type": "text/html; charset=utf-8" } },
  );
}
