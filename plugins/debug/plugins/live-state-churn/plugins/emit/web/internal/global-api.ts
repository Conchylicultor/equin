import { useEffect } from "react";
import {
  useFetchEndpoint,
  type FetchEndpoint,
} from "@plugins/infra/plugins/endpoints/web";
import { LIVE_STATE_EMIT_GLOBAL } from "../../core";
import type { LiveStateEmitGlobal } from "../../core";
import { startEmit, stopEmit, getEmitStatus } from "../../shared/endpoints";

// The interface itself lives in core/global-api.ts so the headless e2e driver —
// which may import core but not web — augments Window with the SAME type this
// installer does. Two structurally-identical local copies would be distinct
// types on one Window key, which TypeScript rejects (TS2717).
declare global {
  interface Window {
    [LIVE_STATE_EMIT_GLOBAL]?: LiveStateEmitGlobal;
  }
}

let installed = false;

/**
 * Install the window-level imperative API, over `fetchEndpoint` — the page
 * root's (the installer is a `Core.Root`, under the page transport). Idempotent.
 */
export function installGlobalApi(fetchEndpoint: FetchEndpoint): void {
  if (installed) return;
  installed = true;
  window[LIVE_STATE_EMIT_GLOBAL] = {
    start: ({ key, rate, durationMs }) =>
      fetchEndpoint(startEmit, {}, { body: { key, rate, durationMs } }),
    stop: () => fetchEndpoint(stopEmit, {}),
    status: () => fetchEndpoint(getEmitStatus, {}),
  };
}

/** Invisible component mounted via Core.Root to install the global API once. */
export function EmitInstaller(): null {
  const fetchEndpoint = useFetchEndpoint();
  useEffect(() => {
    installGlobalApi(fetchEndpoint);
  }, [fetchEndpoint]);
  return null;
}
