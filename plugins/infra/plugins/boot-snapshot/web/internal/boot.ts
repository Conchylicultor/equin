import { Core } from "@plugins/framework/plugins/web-sdk/core";
import { fetchEndpoint } from "@plugins/infra/plugins/endpoints/web";
import {
  hydrateResource,
  resourceDescriptorByKey,
} from "@plugins/primitives/plugins/live-state/web";
import { recordBootSpan } from "@plugins/primitives/plugins/perfs/plugins/boot-trace/web";
import { report } from "@plugins/reports/web";
import { bootSnapshot } from "../../core";

// Boot-readiness task: fetch every boot-critical resource in ONE request and seed the
// live-state cache before first paint (no `pending` flash, no WS round-trip).
//
// The snapshot ships ONLY boot-critical resources (the single source is the shared
// descriptor's `preload`, which `Resource.Declare` derives) and omits any whose loader failed this
// boot, so ITS KEYS are the authoritative set to hydrate. We resolve each key to its
// client descriptor via the live-state descriptor registry (populated when each
// descriptor module is evaluated, which happens before boot tasks run). A snapshot key
// with no registered descriptor means a boot-critical resource whose descriptor was not
// in the eager web import graph — a real bug, surfaced loudly rather than silently lost.
export async function runBootSnapshot(): Promise<void> {
  const reqStart = performance.now();
  const { resources, tuples, timings } = await fetchEndpoint(bootSnapshot, {});
  const reqMs = performance.now() - reqStart;
  recordBootSpan({
    id: "boot-snapshot",
    phase: "boot-tasks",
    label: "Boot snapshot fetch",
    startMs: reqStart,
    durationMs: reqMs,
  });
  for (const key of [...Object.keys(resources), ...Object.keys(tuples)]) {
    const t = timings[key];
    recordBootSpan({
      id: `res:${key}`,
      phase: "resources",
      label: key,
      startMs: reqStart,
      durationMs: reqMs,
      workMs: t?.workMs,
      detail: t?.source,
    });
  }
  const missing: string[] = [];
  const failed: string[] = [];
  // One bad entry (a value its client schema rejects) must not stop every
  // entry after it: each hydrate is isolated, and a failure is reported.
  const hydrate = (
    d: NonNullable<ReturnType<typeof resourceDescriptorByKey>>,
    params: Record<string, string> | undefined,
    value: unknown,
  ) => {
    try {
      hydrateResource(d, params, value);
    } catch (err) {
      failed.push(
        `${d.key} ${JSON.stringify(params ?? {})}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  };
  for (const key of Object.keys(resources)) {
    const d = resourceDescriptorByKey(key);
    if (!d) {
      missing.push(key);
      continue;
    }
    // A descriptor with defaultParams (a windowed resource's default window)
    // hydrates at that tuple — the same one the server's fallback loader used
    // and the one a bare useLive(c) subscribes to. Plain global resources
    // keep the param-less tuple.
    hydrate(d, d.defaultParams, resources[key]);
  }
  // An enumerated preload (a parameterized value) ships every tuple with its
  // params — canonical, the same tuple its readers subscribe.
  for (const [key, entries] of Object.entries(tuples)) {
    const d = resourceDescriptorByKey(key);
    if (!d) {
      missing.push(key);
      continue;
    }
    for (const e of entries) hydrate(d, e.params, e.value);
  }
  // The "first commit after boot snapshot" instant (FIRST_DATA_COMMIT_ID) is
  // armed by App itself, right before it swaps the boot screen for the app: the
  // boot screen commits too (its elapsed clock), so "the next commit after this
  // hydrate" would no longer be App's first real render.
  if (failed.length) {
    const more = failed.length > 5 ? ` (+${failed.length - 5} more)` : "";
    const summary = `boot-snapshot: hydrate failed for ${failed.slice(0, 5).join("; ")}${more}`;
    console.error(`[boot-snapshot] ${summary}`);
    void report({
      kind: "crash",
      source: "boot-snapshot",
      message: summary,
      url: window.location.href,
      userAgent: navigator.userAgent,
      data: {
        errorType: "BootSnapshotHydrateFailed",
        stack: new Error(summary).stack ?? null,
      },
    });
  }
  if (missing.length) {
    // The crash collector's window error listener is NOT mounted yet during the boot
    // window (RootRenderer mounts after the boot tasks settle), so a queueMicrotask
    // throw would only reach the console. report() is a direct keepalive POST that
    // files a deduped crash task regardless of mount state.
    const summary = `boot-snapshot: unresolved descriptor key(s): ${missing.join(", ")}`;
    console.error(
      `[boot-snapshot] no descriptor registered for: ${missing.join(", ")}`,
    );
    void report({
      kind: "crash",
      source: "boot-snapshot",
      message: summary,
      url: window.location.href,
      userAgent: navigator.userAgent,
      // Matches the crash kind's CrashPayloadSchema (errorType + stack). No real
      // Error is thrown here, so we synthesize a minimal stack for fingerprinting.
      data: {
        errorType: "BootSnapshotUnresolvedDescriptor",
        stack: new Error(summary).stack ?? null,
      },
    });
  }
}

// `block`: without the snapshot the app has no boot-critical data. A stalled or
// failing snapshot shows App's boot error state (and files a client report)
// rather than painting an app whose every read is a stand-in.
export const bootSnapshotTask = Core.Boot({
  label: "Boot snapshot",
  ifUnavailable: "block",
  run: runBootSnapshot,
});
