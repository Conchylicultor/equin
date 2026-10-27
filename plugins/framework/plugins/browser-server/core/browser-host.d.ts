// A browser host, as the page imports it: the module web-artifacts builds from
// a plugin's `bin/browser-host.ts` and maps as `@browser-host/<pluginPath>`
// (`web-artifacts/core/internal/browser-hosts.ts`). `start` starts the
// worker — `portBrowserServer(worker)` is the server in it — and
// `serviceWorkerUrl` is the frame-serving Service Worker built beside it
// (`web/frames-sw.ts`, registered by `attachFrameServing`). Typed here rather
// than through a tsconfig path: the module exists only in a built dist.
declare module "@browser-host/*" {
  /** Start the host's Web Worker (one boot of its graph per call). */
  export function start(): Worker;
  /** The absolute URL of the host's frame-serving Service Worker script. */
  export const serviceWorkerUrl: string;
}
