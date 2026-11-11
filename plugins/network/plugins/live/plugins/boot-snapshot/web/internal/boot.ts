import { Core } from "@plugins/framework/plugins/web-sdk/core";
import {
  sendEndpointRequest,
  readEndpointResponse,
} from "@plugins/infra/plugins/endpoints/core";
import { pageTransport } from "@plugins/primitives/plugins/networking/plugins/page-transport/web";
import { recordBootSpan } from "@plugins/primitives/plugins/perfs/plugins/boot-trace/web";
import { report } from "@plugins/reports/web";
import { bootSnapshot } from "../../core";
import { hydrateBootSnapshot } from "./hydrate";

// Boot-readiness task: fetch every boot-critical resource in ONE request and seed the
// live-state cache before first paint (no `pending` flash, no WS round-trip).
//
// The snapshot ships ONLY boot-critical resources (the single source is the shared
// descriptor's `preload`, which `Resource.Declare` derives) and omits any whose loader failed this
// boot, so ITS KEYS are the authoritative set to hydrate (`hydrateBootSnapshot`). A
// snapshot key with no registered descriptor means a boot-critical resource whose
// descriptor was not in the eager web import graph — a real bug, surfaced loudly rather
// than silently lost.
export async function runBootSnapshot(): Promise<void> {
  const reqStart = performance.now();
  // Boot belongs to the page: the snapshot always hydrates from the page's own
  // server. A substrate read of live itself (it seeds the cache `useLive`
  // reads), so it is the transport's raw fetch, kept on the contract: the
  // request built and the reply decoded by the endpoint's own codec.
  const { resources, tuples, timings } = await readEndpointResponse(
    bootSnapshot,
    await sendEndpointRequest(pageTransport.fetch, bootSnapshot, {}),
  );
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
  const { missing, failed } = hydrateBootSnapshot({ resources, tuples });
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
    // window (RenderCoreRoot mounts after the boot tasks settle), so a queueMicrotask
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
