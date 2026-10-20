import { onClaudeCodeProbed } from "@plugins/infra/plugins/claude-cli/plugins/availability/server";
import { isHostSingleton } from "@plugins/infra/plugins/paths/core";
import { modelsDiscoverJob } from "./discover-job";
import { readFileCatalog } from "./store";

/**
 * Re-discover whenever the availability probe reports a Claude CLI version the
 * catalog was not read with. A CLI auto-update is exactly when the model menu moves,
 * so a new model usually appears within minutes of the CLI knowing it. A
 * catalog never probed (`cliVersion: null`) differs from every version, so a
 * fresh machine discovers on its first probe.
 *
 * Push-based: it rides the probes the app already makes (launches, the health
 * row, Check again). The job is a singleton, so a burst of probes before the
 * run lands queues one run.
 */
let unsubscribe: (() => void) | null = null;

export function startCliVersionTrigger(): void {
  unsubscribe ??= onClaudeCodeProbed((status) => {
    if (status.kind !== "ready" || !isHostSingleton()) return;
    if (status.version === readFileCatalog().cliVersion) return;
    void modelsDiscoverJob.enqueue({});
  });
}

export function stopCliVersionTrigger(): void {
  unsubscribe?.();
  unsubscribe = null;
}
