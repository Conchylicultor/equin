// Frame serving's shared vocabulary: what the page (`frame-serving.ts`) and the
// frame-serving Service Worker (`frames-sw.ts`) say to each other, where a
// frame URL sits, and how the Service Worker reads one. Pure — the Service
// Worker bundles it, so it imports nothing but this plugin's own files.
//
// A browser host's artifact dir holds its Service Worker script beside the
// host module (`/artifacts/<dir>/frames-sw.js`, built by web-artifacts'
// `browser-hosts.ts`); its scope is the `frames/` dir next to it, and one
// frame URL is `<scope><serverId>/api/…` — the server's own `/api` path behind
// a per-attachment id, so two tabs (two workers) never answer each other's
// frames. An uncontrolled request there (a shift-reload, no Service Worker)
// misses the artifact store, which the gateway answers 404 — never the app.

/** The origin a relative request is resolved against: never fetched, only parsed. */
export const REQUEST_BASE = "http://browser-server.invalid";

/** The scope dir, relative to the Service Worker script. */
const FRAMES_DIR = "frames/";

/** How long a Service Worker woken without a port waits for the page to hand it one. */
export const FRAMES_PORT_WAIT_MS = 5_000;

/** The absolute scope URL of the Service Worker at `serviceWorkerUrl`. */
export function framesScope(serviceWorkerUrl: string): string {
  return new URL(FRAMES_DIR, serviceWorkerUrl).href;
}

/**
 * Whether a registration's scope is a frame-serving one — any build's
 * (`/artifacts/<dir>/frames/`), so a page can drop the ones a previous build
 * left behind.
 */
export function isFramesScope(scope: string): boolean {
  return /^\/artifacts\/[^/]+\/frames\/$/.test(new URL(scope).pathname);
}

/** Page → Service Worker. */
export type ToFramesSw =
  /** Answer `serverId`'s frames through `port` (a port the server's worker answers on). */
  | { t: "attach"; serverId: string; port: MessagePort }
  /** `serverId`'s server is gone: drop its port. */
  | { t: "detach"; serverId: string };

/** Service Worker → page. */
export type FromFramesSw =
  /** A frame of `serverId` asked, and its port is gone (the Service Worker was restarted): hand a fresh one. */
  { t: "need-port"; serverId: string };

/** Where a request under the scope goes. */
export type FrameRoute =
  /** `path` (`/api/…`, still encoded) on the server attached as `serverId`. */
  | { kind: "route"; serverId: string; path: string }
  /** Not a frame URL: no server id, or not an `/api` path. */
  | { kind: "not-found" }
  /** A segment that decodes to a traversal or a separator. */
  | { kind: "bad-path"; segment: string };

/**
 * Route `pathname` (a request's, under `scopePath`): the server id, then the
 * server's own path. Every segment is decoded and refused when it names `.`,
 * `..` or holds a separator or NUL — the URL parser has already folded literal
 * dot segments, an encoded one (`%2e%2e`, `%2f`) reaches here.
 */
export function routeFrameRequest(
  scopePath: string,
  pathname: string,
): FrameRoute {
  if (!pathname.startsWith(scopePath)) return { kind: "not-found" };
  const rest = pathname.slice(scopePath.length);
  const slash = rest.indexOf("/");
  if (slash <= 0) return { kind: "not-found" };
  const path = rest.slice(slash);
  if (!path.startsWith("/api/")) return { kind: "not-found" };
  for (const segment of path.slice(1).split("/")) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(segment);
    } catch (err) {
      if (err instanceof URIError) return { kind: "bad-path", segment };
      throw err;
    }
    if (decoded === "." || decoded === ".." || /[/\\\0]/.test(decoded)) {
      return { kind: "bad-path", segment };
    }
  }
  return { kind: "route", serverId: rest.slice(0, slash), path };
}
