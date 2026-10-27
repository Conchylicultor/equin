import {
  defineReportSink,
  type ReportSink,
} from "@plugins/primitives/plugins/report-sink/core";

/**
 * The page request guard: the runtime half (rung 4) of "the browser reads the
 * app's server only through live values and writes only through typed
 * endpoints". Once installed, a same-origin request to `/api/*`, `/ws/*` or
 * `/gateway/*` the page issues by any raw channel — `fetch` (string, URL or
 * `Request`), `XMLHttpRequest`, `navigator.sendBeacon`, `EventSource`,
 * `WebSocket` — is refused. The app's own channels hold a CAPABILITY instead of
 * a mark: `nativeFetch` (the page transport's `fetch`) and `nativeWebSocket`
 * (the per-tab reconnecting socket) reach the natives the guard kept, and who
 * may import them is bounded by `networking/no-request-guard-capability`.
 *
 * Assets are the one exception: an element or a library loading an asset by
 * URL on its own (an emoji picker's data, a sampler's samples) sends a GET /
 * HEAD of an asset route — the routes `allowAssetRoute` registered (every URL
 * `assetUrlOver` hands out, every element src `useAssetSrc` hands out — a
 * screenshot re-fetches those to inline them — plus the asset mirror's prefix
 * at install).
 *
 * Not covered, by construction (recorded, not guarded): a same-origin iframe's
 * own `contentWindow.fetch`, `window.open`, a blob `new Worker`, and element
 * loads (`<img>`, `<iframe>`, CSS) — those are not requests page code issues.
 */

/** The channel a refused request was issued on. */
export type GuardedChannel =
  "fetch" | "XMLHttpRequest" | "sendBeacon" | "EventSource" | "WebSocket";

const GUARDED_ROOTS = ["/api", "/ws", "/gateway"] as const;

/**
 * A raw request to the app's own server, refused by the page request guard.
 * `fetch` rejects with it; every other channel throws it.
 */
export class RawApiRequestError extends Error {
  override readonly name = "RawApiRequestError";
  constructor(
    readonly channel: GuardedChannel,
    readonly method: string,
    /** The refused path (and query), same-origin. */
    readonly path: string,
  ) {
    super(
      `Refused a raw ${channel} ${method} ${path}: page code reaches the app's server only through its transport — ` +
        "read server data with useLive (useLiveReader in an event handler), write with fetchEndpoint / useEndpointMutation. " +
        "Agents: to inspect data, use the query_db MCP tool; an e2e script calls the API as the page with pageFetch " +
        "(e2e-harness, over Playwright's page.request), never an in-page fetch.",
    );
  }
}

/**
 * Every violation, for the crash collector (`reports/crash`) to file. Held
 * until it registers, so a violation raised during boot — before any
 * `Core.Root` effect has run — is replayed rather than lost.
 */
export const requestGuardReportSink: ReportSink<RawApiRequestError> =
  defineReportSink<RawApiRequestError>();

/** Path prefixes a GET / HEAD may load as an asset (see `allowAssetRoute`). */
const assetRoutes = new Set<string>();

/**
 * Let GET / HEAD load `path` (and everything under it) as an asset: the
 * pathname of an asset URL or asset base a sink loads by URL on its own. Its
 * query is ignored. Callers are bounded by `no-request-guard-capability`.
 */
export function allowAssetRoute(path: string): void {
  const pathname = path.split(/[?#]/, 1)[0]!.replace(/\/+$/, "");
  if (!pathname.startsWith("/")) {
    throw new Error(
      `allowAssetRoute("${path}"): an asset route is an app-relative path`,
    );
  }
  assetRoutes.add(pathname);
}

const underRoot = (pathname: string, root: string): boolean =>
  pathname === root || pathname.startsWith(`${root}/`);

function isAssetLoad(method: string, pathname: string): boolean {
  if (method !== "GET" && method !== "HEAD") return false;
  for (const route of assetRoutes) if (underRoot(pathname, route)) return true;
  return false;
}

interface Natives {
  fetch: typeof fetch | undefined;
  WebSocket: typeof WebSocket | undefined;
  EventSource: typeof EventSource | undefined;
  xhrOpen: XMLHttpRequest["open"] | undefined;
  sendBeacon: Navigator["sendBeacon"] | undefined;
}

/** The natives the installed guard replaced; null when none is installed. */
// eslint-disable-next-line install-sink/no-adhoc-install-sink -- filled once at module eval of the app entry, before React or any plugin module runs, and read only at request time (nativeFetch / nativeWebSocket), never in render; the guard must evaluate first, so it cannot depend on the React-backed defineInstallSink
let natives: Natives | null = null;

/**
 * The refusal for one request, or null when it may go. `raw` is resolved
 * against `document.baseURI`; only the page's own origin is guarded (a socket
 * matches it by host, its scheme being `ws(s):`).
 */
function refusal(
  channel: GuardedChannel,
  method: string,
  raw: string,
): RawApiRequestError | null {
  // An unparseable URL is not a request to anyone: the native rejects it with
  // its own error.
  if (!URL.canParse(raw, document.baseURI)) return null;
  const url = new URL(raw, document.baseURI);
  const sameOrigin =
    channel === "WebSocket"
      ? url.host === window.location.host
      : url.origin === window.location.origin;
  if (!sameOrigin) return null;
  if (!GUARDED_ROOTS.some((root) => underRoot(url.pathname, root))) return null;
  if (channel !== "WebSocket" && isAssetLoad(method, url.pathname)) return null;
  return new RawApiRequestError(channel, method, url.pathname + url.search);
}

/**
 * Make the violation impossible to miss, whatever the caller does with it: a
 * library that swallows the rejection (frimousse catches its HEAD's) cannot
 * hide it. Filed once, through the sink — the crash collector ignores the
 * `reportError` echo of a `RawApiRequestError`.
 */
function surface(err: RawApiRequestError): RawApiRequestError {
  console.error(err);
  requestGuardReportSink.emit(err);
  if (typeof globalThis.reportError === "function") globalThis.reportError(err);
  return err;
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

function requestMethod(input: RequestInfo | URL, init?: RequestInit): string {
  const method =
    init?.method ??
    (typeof input === "object" && !(input instanceof URL)
      ? input.method
      : "GET");
  return method.toUpperCase();
}

/** A constructor that refuses a guarded URL before constructing. */
function guardedConstructor<
  C extends abstract new (...args: never[]) => object,
>(native: C, channel: "WebSocket" | "EventSource"): C {
  return new Proxy(native, {
    construct(target, args: unknown[], newTarget) {
      const err = refusal(channel, "GET", String(args[0]));
      if (err) throw surface(err);
      return Reflect.construct(target, args, newTarget) as object;
    },
  });
}

/**
 * Install the guard on this realm. Called once, by the app's entry
 * (`framework/web-core`'s `main.tsx`, through a side-effect module imported
 * before anything else). Returns the uninstall, which restores every native —
 * for a test; the app never uninstalls. Installing twice throws.
 */
export function installRequestGuard(): () => void {
  if (natives) throw new Error("installRequestGuard: already installed");
  const g = globalThis;
  // Only what this realm has: jsdom lacks EventSource and sendBeacon.
  const kept: Natives = {
    fetch: typeof g.fetch === "function" ? g.fetch : undefined,
    WebSocket: typeof g.WebSocket === "function" ? g.WebSocket : undefined,
    EventSource:
      typeof g.EventSource === "function" ? g.EventSource : undefined,
    xhrOpen:
      typeof g.XMLHttpRequest === "function"
        ? g.XMLHttpRequest.prototype.open
        : undefined,
    sendBeacon:
      typeof g.navigator === "object" &&
      typeof g.navigator.sendBeacon === "function"
        ? g.navigator.sendBeacon
        : undefined,
  };
  natives = kept;

  if (kept.fetch) {
    const nativeFn = kept.fetch;
    const guardedFetch = (
      input: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<Response> => {
      const err = refusal(
        "fetch",
        requestMethod(input, init),
        requestUrl(input),
      );
      if (err) return Promise.reject(surface(err));
      return nativeFn.call(g, input, init);
    };
    // A host's `typeof fetch` may carry extras (Bun's `preconnect`) a page's
    // fetch has none of; the guard wraps the call only.
    g.fetch = guardedFetch as typeof fetch;
  }
  if (kept.WebSocket) {
    g.WebSocket = guardedConstructor(kept.WebSocket, "WebSocket");
  }
  if (kept.EventSource) {
    g.EventSource = guardedConstructor(kept.EventSource, "EventSource");
  }
  if (kept.xhrOpen) {
    const nativeOpen = kept.xhrOpen;
    g.XMLHttpRequest.prototype.open = function guardedOpen(
      this: XMLHttpRequest,
      method: string,
      url: string | URL,
      ...rest: unknown[]
    ) {
      const err = refusal(
        "XMLHttpRequest",
        method.toUpperCase(),
        typeof url === "string" ? url : url.href,
      );
      if (err) throw surface(err);
      return (nativeOpen as (...a: unknown[]) => void).call(
        this,
        method,
        url,
        ...rest,
      );
    } as XMLHttpRequest["open"];
  }
  if (kept.sendBeacon) {
    const nativeBeacon = kept.sendBeacon;
    g.navigator.sendBeacon = function guardedBeacon(url, data) {
      const err = refusal(
        "sendBeacon",
        "POST",
        typeof url === "string" ? url : url.href,
      );
      if (err) throw surface(err);
      return nativeBeacon.call(g.navigator, url, data);
    };
  }

  return () => {
    if (natives !== kept) return;
    if (kept.fetch) g.fetch = kept.fetch;
    if (kept.WebSocket) g.WebSocket = kept.WebSocket;
    if (kept.EventSource) g.EventSource = kept.EventSource;
    if (kept.xhrOpen) g.XMLHttpRequest.prototype.open = kept.xhrOpen;
    if (kept.sendBeacon) g.navigator.sendBeacon = kept.sendBeacon;
    natives = null;
  };
}

/**
 * The native `fetch`, past the guard — the page transport's `fetch`. With no
 * guard installed (a jsdom suite, a host without the app entry) it is the
 * global `fetch`, read at call time, so a test's stub answers.
 */
export function nativeFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const fn = natives?.fetch ?? globalThis.fetch;
  return fn.call(globalThis, input, init);
}

/**
 * A `WebSocket` opened past the guard — the per-tab reconnecting socket. With
 * no guard installed it is the global `WebSocket`, read at call time.
 */
export function nativeWebSocket(
  url: string | URL,
  protocols?: string | string[],
): WebSocket {
  const Ctor = natives?.WebSocket ?? globalThis.WebSocket;
  return Reflect.construct(Ctor, [url, protocols]);
}
