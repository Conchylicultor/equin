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
/** The starting data's URL: its bytes are counted as they stream (`reportDataProgress`), not again when its entry lands. */
let dataUrl: string | null = null;

function publish(next: HostProgress): void {
  current = next;
  for (const listener of listeners) listener(current);
}

/**
 * Count what the worker downloads, from its resource entries (`buffered`:
 * the entry modules fetched before this ran too). Where the realm has no
 * `PerformanceObserver` for resources, the count stays at the starting data's
 * bytes alone.
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
    for (const entry of list.getEntries()) {
      if (entry.name === dataUrl) continue;
      bytes += (entry as PerformanceResourceTiming).transferSize;
    }
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
 * `total` bytes). Its bytes are counted here as they stream, so its resource
 * entry is not counted again when the fetch completes.
 */
export function reportDataProgress(
  url: string,
  received: number,
  total: number,
): void {
  // A new load (another url, or the same one again after a Reset) counts
  // from nothing; the same load from what it had counted.
  const prev = current.data;
  const before =
    dataUrl === url && prev !== null && received >= prev.received
      ? prev.received
      : 0;
  dataUrl = url;
  publish({
    ...current,
    downloadedBytes: current.downloadedBytes + (received - before),
    data: { received, total },
  });
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
