import type { DemoHost } from "@plugins/framework/plugins/browser-server/plugins/demo/core";
import { hostDataStored } from "@plugins/framework/plugins/browser-server/plugins/host-storage/plugins/stored/core";
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
 * Only where this browser already holds the demo's data (`storage`, read by
 * `hostDataStored`): a first visit downloads the whole server and its data,
 * which waits for the visitor to ask (`<DemoScope>`'s gate) — so it starts
 * nothing ahead.
 *
 * Nothing to start where the browser has no SharedWorker: the scope then
 * starts a dedicated worker of its own. A name that no longer matches by the
 * time the scope connects (another tab sent a Reset meanwhile) leaves this
 * worker unclaimed; the scope's own worker then takes the storage over (one
 * owner at a time), so only the head start is lost.
 */
export async function prestartDemoHost(
  scenarioId: string,
  storage: string | null,
  host: HostModule,
): Promise<void> {
  if (typeof SharedWorker !== "function") return;
  if (storage === null || !(await hostDataStored(storage))) return;
  host.prestartShared(hostWorkerName(scenarioId, hostGeneration(scenarioId)));
}
