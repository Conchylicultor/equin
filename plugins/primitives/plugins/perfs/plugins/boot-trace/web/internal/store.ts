// Module-level boot-span store. Imported eagerly during framework boot so the
// store is live before any resource mounts. Everything shares one clock:
// `performance.now()` is relative to `performance.timeOrigin` (≈ navigationStart),
// and Navigation/Paint Timing entries are already on that same epoch — so no
// custom epoch wiring is needed.

// The boot-trace data model lives in the cross-runtime core leaf so server-side
// persistence (boot-profile permalinks) can import the shapes without importing
// a web barrel. Re-exported from the web barrel for existing web consumers.
import { useMemo, useSyncExternalStore } from "react";
import type {
  BootPhase,
  BootSpan,
  NavTiming,
  LongTask,
  AssetTiming,
  BootTrace,
  BootTimingDetail,
  BootPluginLoadDetail,
} from "../../core";
import { BOOT_PLUGIN_TIMING_PREFIX, BOOT_TIMING_PREFIX } from "../../core";

const spans: BootSpan[] = [];
const longTasks: LongTask[] = [];
let firstCommitMs: number | null = null;

// Subscribers re-read getBootTrace() when late timing (FCP / first-paint) or new
// spans arrive. Hoisted function declarations let the boot-time IIFEs below call
// notify() even though they appear earlier in source order.
const listeners = new Set<() => void>();
// Monotonic version bumped on every notify(). It is the stable
// `useSyncExternalStore` snapshot: getBootTrace() returns a fresh object on each
// call (new array spreads + capturedAt), so a useSyncExternalStore getSnapshot
// can't return it directly without looping — the version is the change token, and
// callers re-read getBootTrace() keyed on it.
// eslint-disable-next-line scoped-store/no-module-mutable-store -- page-global by design: this module-level store captures the ONE boot trace of the current page load (alongside the existing module-level `spans` / `longTasks` / `firstCommitMs`), filled by framework boot instrumentation before any surface mounts. There is no per-surface boot — every mount of the boot-profile pane reads the same single trace, so the version counter is intentionally global.
let version = 0;
function notify(): void {
  version += 1;
  for (const l of listeners) l();
}

/**
 * Subscribe to boot-trace updates. The callback fires when late paint timing
 * (FCP / first-paint) lands, the first React commit is stamped, or a new span is
 * recorded — letting a mounted view re-read getBootTrace(). Returns an unsubscribe.
 */
export function subscribeBootTrace(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

/** The change token for the store — bumped on every notify(). */
export function getBootTraceVersion(): number {
  return version;
}

/**
 * Force a re-read of the trace. Navigation/Paint/Asset timing are read lazily at
 * getBootTrace() call time, so a manual refresh just needs to bump the version
 * and notify — subscribers then re-pull the freshly-read timing. Drives the
 * boot-profile "Refresh" button without any component-local state.
 */
export function refreshBootTrace(): void {
  notify();
}

/**
 * Mirror one recorded span into the browser's User Timing buffer: an instant
 * (0 ms) as a `mark`, a span as a `measure`, both named `boot:<id>` and
 * carrying the span's phase / label / workMs / detail as `detail`. Same clock
 * as the store (`performance.now()` on `timeOrigin`).
 */
function emitUserTiming(span: BootSpan): void {
  const detail: BootTimingDetail = {
    phase: span.phase,
    label: span.label,
    ...(span.workMs !== undefined ? { workMs: span.workMs } : {}),
    ...(span.detail !== undefined ? { detail: span.detail } : {}),
  };
  const name = `${BOOT_TIMING_PREFIX}${span.id}`;
  if (span.durationMs === 0) {
    performance.mark(name, { startTime: span.startMs, detail });
  } else {
    performance.measure(name, {
      start: span.startMs,
      duration: span.durationMs,
      detail,
    });
  }
}

/** Explicit push (used for resource wait/work spans carrying a server `workMs`). */
export function recordBootSpan(span: BootSpan): void {
  spans.push(span);
  emitUserTiming(span);
  notify();
}

/**
 * Open a span now and return a closer. Calling the closer records the span with
 * its measured duration. The single clock means `startMs` is simply
 * `performance.now()` at the open instant.
 */
export function startBootSpan(
  id: string,
  phase: BootPhase,
  label: string,
): () => void {
  const startMs = performance.now();
  return () => {
    recordBootSpan({
      id,
      phase,
      label,
      startMs,
      durationMs: performance.now() - startMs,
    });
  };
}

/** Record a 0-duration marker span at the current instant. */
export function markBootInstant(
  id: string,
  phase: BootPhase,
  label: string,
): void {
  recordBootSpan({
    id,
    phase,
    label,
    startMs: performance.now(),
    durationMs: 0,
  });
}

/**
 * Time one plugin module import: runs `load` and, when it settles, records a
 * `boot-plugin:<pluginPath>` User Timing measure from the call to the settle —
 * its artifacts' fetch plus their evaluation, behind whatever else the same
 * flat import wave is fetching. User Timing only (see BOOT_PLUGIN_TIMING_PREFIX);
 * the import's result or rejection passes through unchanged.
 */
export async function traceBootPluginLoad<T>(
  pluginPath: string,
  tier: BootPluginLoadDetail["tier"],
  load: () => Promise<T>,
): Promise<T> {
  const start = performance.now();
  let ok = false;
  try {
    const value = await load();
    ok = true;
    return value;
  } finally {
    const detail: BootPluginLoadDetail = { tier, ok };
    performance.measure(`${BOOT_PLUGIN_TIMING_PREFIX}${pluginPath}`, {
      start,
      end: performance.now(),
      detail,
    });
  }
}

/**
 * Stamp a 0-duration marker at the NEXT React commit (of any root) after this
 * call — for an instant defined by "the first render once X is true", which no
 * call site can stamp itself because the commit happens inside React. Stamped
 * at commit time (before the browser paints it). No-op when the commit bridge
 * (`web-core/web/index.html`) is absent, like the first-commit capture.
 */
export function markBootInstantAtNextCommit(
  id: string,
  phase: BootPhase,
  label: string,
): void {
  onNextCommit(() => markBootInstant(id, phase, label));
}

function readNavTiming(): NavTiming | null {
  const [entry] = performance.getEntriesByType(
    "navigation",
  ) as PerformanceNavigationTiming[];
  if (!entry) return null;
  // All fields are already relative to `timeOrigin`, so use them directly.
  return {
    fetchStartMs: entry.fetchStart,
    domainLookupStartMs: entry.domainLookupStart,
    domainLookupEndMs: entry.domainLookupEnd,
    connectStartMs: entry.connectStart,
    connectEndMs: entry.connectEnd,
    requestStartMs: entry.requestStart,
    responseStartMs: entry.responseStart,
    responseEndMs: entry.responseEnd,
    domInteractiveMs: entry.domInteractive,
    domContentLoadedEndMs: entry.domContentLoadedEventEnd,
  };
}

function readPaintTiming(): {
  firstPaintMs: number | null;
  firstContentfulPaintMs: number | null;
} {
  const entries = performance.getEntriesByType("paint");
  const find = (name: string) =>
    entries.find((e) => e.name === name)?.startTime ?? null;
  return {
    firstPaintMs: find("first-paint"),
    firstContentfulPaintMs: find("first-contentful-paint"),
  };
}

function readAssets(): AssetTiming[] {
  // Resource Timing is retained on the timeline and readable at any time, so —
  // unlike the span store — it covers the pre-boot-trace window (the eager
  // bundle + the plugin-chunk fan-out). Keep only scripts/stylesheets; /api and
  // /ws fetches are already represented as resource-phase spans. Dynamic
  // `import()` fetches (the per-plugin web-artifacts import-map chunks — the
  // bulk of boot JS) report initiatorType "other", so they are admitted by
  // extension instead.
  const isModuleChunk = (e: PerformanceResourceTiming) =>
    e.initiatorType === "other" && /\.m?js(\?|$)/.test(e.name);
  return (
    performance.getEntriesByType("resource") as PerformanceResourceTiming[]
  )
    .filter(
      (e) =>
        e.initiatorType === "script" ||
        e.initiatorType === "link" ||
        e.initiatorType === "css" ||
        isModuleChunk(e),
    )
    .map((e) => ({
      name: e.name,
      initiatorType: e.initiatorType,
      startMs: e.startTime,
      responseStartMs: e.responseStart,
      responseEndMs: e.responseEnd,
      transferSize: e.transferSize,
      decodedBodySize: e.decodedBodySize,
    }));
}

/**
 * When boot "ends" on the shared clock — the later of first-contentful-paint and
 * the first React commit. The single source of truth so the long-task phase and
 * the cost summary agree on which tasks count as boot (vs. later interaction).
 * Returns 0 when neither is known yet (caller should then not clip).
 */
export function bootWindowEnd(trace: BootTrace): number {
  return Math.max(
    trace.paint.firstContentfulPaintMs ?? 0,
    trace.firstCommitMs ?? 0,
  );
}

/** Assemble the current trace. Navigation/paint/assets are read lazily at call time. */
export function getBootTrace(): BootTrace {
  return {
    spans: [...spans],
    navigation: readNavTiming(),
    paint: readPaintTiming(),
    firstCommitMs,
    longTasks: [...longTasks],
    assets: readAssets(),
    capturedAt: performance.now(),
  };
}

/**
 * Live boot trace as a React hook. Subscribes to the store via
 * useSyncExternalStore (the version is the stable snapshot — getBootTrace()
 * itself returns a fresh object each call), then re-assembles the trace whenever
 * the version advances (late paint timing, first commit, new spans, or a manual
 * refreshBootTrace()). Replaces the useEffect(setTrace(getBootTrace())) mirror.
 */
export function useBootTrace(): BootTrace {
  // `v` is the change token (getBootTrace() returns a fresh object each call, so
  // it can't be the snapshot). Re-assemble the trace only when the version
  // advances — getBootTrace reads the latest mutable store + lazily-read timing.
  const v = useSyncExternalStore(
    subscribeBootTrace,
    getBootTraceVersion,
    () => 0,
  );
  return useMemo(() => {
    void v; // version is the cache key: re-read the mutable store on each advance
    return getBootTrace();
  }, [v]);
}

// --- React commit bridge ------------------------------------------------------
// The commit bridge installed by `web-core/web/index.html` exposes a
// `__commitSubscribers` Set on the DevTools global hook; each subscriber is
// invoked with the committed root on every React commit. `onNextCommit`
// subscribes once, runs `cb` at the next commit, and removes itself. This must
// NEVER throw and brick boot — the hook/Set may not exist, so guard defensively.
function onNextCommit(cb: () => void): void {
  try {
    const hook = (
      window as unknown as {
        __REACT_DEVTOOLS_GLOBAL_HOOK__?: {
          __commitSubscribers?: Set<(root: unknown) => void>;
        };
      }
    ).__REACT_DEVTOOLS_GLOBAL_HOOK__;
    const subscribers = hook?.__commitSubscribers;
    if (!subscribers) return;
    const onCommit = () => {
      subscribers.delete(onCommit);
      cb();
    };
    subscribers.add(onCommit);
    // boot-path instrumentation must never throw and brick boot; the commit bridge is best-effort, so any failure to install the one-shot subscriber is safe to drop (the trace simply lacks the instant).
  } catch (err) {
    void err;
  }
}

// --- First React commit capture (one-shot, at module eval time) --------------
onNextCommit(() => {
  firstCommitMs = performance.now();
  markBootInstant("first-commit", "paint", "First React commit");
});

// --- Paint timing observer (buffered) ----------------------------------------
// first-paint / first-contentful-paint entries land AFTER mount (and after the
// boot-profile page first reads getBootTrace()), so a one-shot read misses them.
// A buffered PerformanceObserver replays any already-recorded paint entries and
// fires on new ones, notifying subscribers to re-read. This must NEVER throw and
// brick boot — PerformanceObserver/paint may be unsupported, so guard defensively.
(function observePaint() {
  try {
    const obs = new PerformanceObserver(() => notify());
    obs.observe({ type: "paint", buffered: true });
    // boot-path instrumentation must never throw; PerformanceObserver/paint may be unsupported, in which case FCP simply stays null until a manual Refresh.
  } catch (err) {
    void err;
  }
})();

// --- Long task observer (buffered) -------------------------------------------
// The main-thread blocking that fills the bytes-arrived → first-paint gap (bundle
// parse/compile/eval, plugin-chunk fan-out, the first React render) happens while
// the span store can't run. The Long Tasks API records those ≥50ms tasks
// independently; `buffered: true` replays the ones that fired before this module
// evaluated. Must NEVER throw and brick boot — longtask may be unsupported.
(function observeLongTasks() {
  try {
    const obs = new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        longTasks.push({
          startMs: e.startTime,
          durationMs: e.duration,
          name: e.name,
        });
      }
      notify();
    });
    obs.observe({ type: "longtask", buffered: true });
    // boot-path instrumentation must never throw; the Long Tasks API may be unsupported, in which case the main-thread phase simply stays empty.
  } catch (err) {
    void err;
  }
})();
