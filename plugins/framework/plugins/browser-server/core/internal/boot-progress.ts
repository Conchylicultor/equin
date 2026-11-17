// How far a browser host's boot has come, as the worker knows it — reported by
// the layers that do the work (host-storage loading a starting snapshot, the
// graph loading its plugins) and carried to every page waiting for the host
// (`serveHost` posts it as `progress` until `ready`). Worker-global: one host
// boots per worker, and the reporters sit in different plugins.

/**
 * A host's boot so far. Facts, not a percentage: a page weighs them as it
 * shows them (`demo/scope`'s gate).
 */
export interface HostProgress {
  /**
   * Bytes the worker has downloaded so far — its code, the database engine,
   * the starting data — as its resource entries report them (`transferSize`:
   * nothing for what the HTTP cache answered).
   */
  downloadedBytes: number;
  /**
   * The starting data the boot loads (a first visit, a Reset, a newer build's
   * snapshot): bytes received of its size. `null` while none is being loaded
   * — the data was already in this browser, or the boot is not there yet.
   */
  data: { received: number; total: number } | null;
  /** The graph's plugin modules loaded, of how many; `null` before it loads any. */
  plugins: { loaded: number; total: number } | null;
}

type Listener = (progress: HostProgress) => void;

let current: HostProgress = { downloadedBytes: 0, data: null, plugins: null };
const listeners = new Set<Listener>();
let observing = false;

function publish(next: HostProgress): void {
  current = next;
  for (const listener of listeners) listener(current);
}

/**
 * Count what the worker downloads, from its resource entries (`buffered`:
 * the entry modules fetched before this ran too) — the starting data's
 * included, once it has landed. `transferSize` is the bytes on the wire (a
 * compressed body counts compressed), which is what a visitor's connection
 * pays; the starting data's streamed progress (`reportDataProgress`) counts
 * decoded bytes, so it moves the data's fraction only, never this count.
 * Where the realm has no `PerformanceObserver` for resources, the count stays
 * at zero.
 */
function observeDownloads(): void {
  if (observing) return;
  observing = true;
  if (
    typeof PerformanceObserver === "undefined" ||
    !PerformanceObserver.supportedEntryTypes.includes("resource")
  ) {
    return;
  }
  new PerformanceObserver((list) => {
    let bytes = 0;
    for (const entry of list.getEntries())
      bytes += (entry as PerformanceResourceTiming).transferSize;
    if (bytes > 0)
      publish({ ...current, downloadedBytes: current.downloadedBytes + bytes });
  }).observe({ type: "resource", buffered: true });
}

/** The boot so far, and every change after it: what `serveHost` posts to the pages. */
export function watchHostProgress(listener: Listener): () => void {
  observeDownloads();
  listeners.add(listener);
  listener(current);
  return () => listeners.delete(listener);
}

/**
 * The starting data's download from `url`, as it arrives (`received` of
 * `total` bytes, decoded: what the build wrote, whatever encoding carried
 * it). It moves the data's fraction only; its wire bytes join
 * `downloadedBytes` from its resource entry once the fetch completes.
 */
export function reportDataProgress(
  _url: string,
  received: number,
  total: number,
): void {
  publish({ ...current, data: { received, total } });
}

/**
 * The graph's entries, each loader reporting when its module has loaded —
 * what a host's entry point boots (`bootBrowserHost({ entries })`), so the
 * pages see the server arrive plugin by plugin.
 */
export function reportingLoads<M, E extends { loader: () => Promise<M> }>(
  entries: readonly E[],
): (E & { loader: () => Promise<M> })[] {
  const total = entries.length;
  let loaded = 0;
  return entries.map((entry) => ({
    ...entry,
    loader: async (): Promise<M> => {
      const mod = await entry.loader();
      loaded += 1;
      publish({ ...current, plugins: { loaded, total } });
      return mod;
    },
  }));
}
