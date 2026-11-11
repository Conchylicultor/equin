import type {
  Transport,
  TransportSocket,
} from "@plugins/primitives/plugins/networking/web";

/** A static render reached for the network — it must render from what was hydrated. */
export class StaticRenderNetworkError extends Error {
  constructor(what: string) {
    super(
      `[static-render] ${what} during a static render — a static render reads only the boot snapshot it was handed (no server behind it). The read that asked must be a boot-preloaded live resource, or the component must not read during render.`,
    );
    this.name = "StaticRenderNetworkError";
  }
}

/**
 * The transport of a static render: there is no server behind it. Every live
 * read is answered by the boot snapshot hydrated into the cache, so any
 * request or socket is a bug: it throws (or rejects) naming what asked, and is
 * handed to `onViolation` too — a caller that swallows the rejection cannot
 * hide it from the render, which fails on it.
 *
 * - `servesUrls: true` — the HTML is served by the site's own server, so an
 *   element's `/api/…` asset path is the URL it loads from there.
 * - `machine: false` — no computer is behind a static page: a `needsMachine`
 *   read answers `unavailable` without asking.
 * - `telemetry: false` — nothing to report to.
 */
export function createStaticTransport(
  onViolation: (error: StaticRenderNetworkError) => void,
): Transport {
  const violation = (what: string) => {
    const error = new StaticRenderNetworkError(what);
    onViolation(error);
    return error;
  };
  return {
    socketUrl: (path) => `static-render:${path}`,
    openSocket(url): TransportSocket {
      throw violation(`a socket was opened (${url})`);
    },
    fetch(input) {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      return Promise.reject(violation(`a request was made (${url})`));
    },
    servesUrls: true,
    requestTiming: false,
    content: null,
    machine: false,
    telemetry: false,
  };
}
