import { onClaudeCodeProbed } from "@plugins/infra/plugins/claude-cli/plugins/availability/server";
import { isHostSingleton } from "@plugins/infra/plugins/paths/core";
import { modelsDiscoverJob } from "./discover-job";
import { readFileCatalog } from "./store";

/**
 * Re-discover whenever the availability probe reports a Claude Code version the
 * catalog was not read with. A new version — an Agent SDK upgrade landing
 * through build, the only way the bundled build moves — is exactly when the
 * model menu moves, so a new model appears on the first probe after it. A
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
