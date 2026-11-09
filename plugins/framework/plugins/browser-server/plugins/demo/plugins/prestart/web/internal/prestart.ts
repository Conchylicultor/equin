import type { DemoHost } from "@plugins/framework/plugins/browser-server/plugins/demo/core";
import { hostGeneration, hostWorkerName } from "./host-generation";

/** The host module, as the head script imports it (`DemoHost.module`). */
type HostModule = Awaited<ReturnType<DemoHost["start"]>>;

/**
 * Start scenario `scenarioId`'s host now — its SharedWorker, under the name
 * the page's `<DemoScope>` will connect to (`hostWorkerName` at the current
 * generation) — so the host's boot (its worker's code, the database, the
 * plugin graph) runs while the page's own bundle loads instead of after it.
 * Called by the demo page's head script, which imports the host module itself
 * (`DemoHost.module`) and this plugin only — nothing of the app — so it runs
 * early; the scope's first `startShared` of that name is handed this worker
 * (`prestartShared`).
 *
 * Nothing to start where the browser has no SharedWorker: the scope then
 * starts a dedicated worker of its own. A name that no longer matches by the
 * time the scope connects (another tab sent a Reset meanwhile) leaves this
 * worker unclaimed; the scope's own worker then takes the storage over (one
 * owner at a time), so only the head start is lost.
 */
export function prestartDemoHost(scenarioId: string, host: HostModule): void {
  if (typeof SharedWorker !== "function") return;
  host.prestartShared(hostWorkerName(scenarioId, hostGeneration(scenarioId)));
}
