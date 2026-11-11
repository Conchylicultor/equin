import {
  connectSharedHost,
  type SharedHostConnection,
} from "@plugins/framework/plugins/browser-server/core";
import type { DemoHost } from "@plugins/framework/plugins/browser-server/plugins/demo/core";
import { hostDataStored } from "@plugins/framework/plugins/browser-server/plugins/host-storage/plugins/stored/core";
import {
  hostWorkerName,
  trackHostGenerations,
  type HostGenerations,
} from "./host-generation";

/** The host module, as the head script imports it (`DemoHost.module`). */
type HostModule = Awaited<ReturnType<DemoHost["start"]>>;

/** A tab's connection to a scenario's host, at the generation it reached. */
export interface DemoHostConnection {
  connection: SharedHostConnection;
  /** The host generation connected to: the one a Reset moves past. */
  generation: number;
}

/**
 * The head start's connection, per scenario, until the scope takes it. Module
 * state: the head script and the scope import this barrel through the same
 * import-map specifier, so both see one map.
 */
const prestarted = new Map<string, Promise<DemoHostConnection>>();

/**
 * Connect this tab to scenario `scenarioId`'s host — its SharedWorker under the
 * name of the current generation, or of a later one when that generation's
 * worker is retiring (`connectSharedHost` skips it, and the generation moves
 * past it page-wide). The head start's connection when there is one still at
 * the current generation (`prestartDemoHost`); otherwise a new one.
 */
export async function connectDemoHost(
  scenarioId: string,
  host: HostModule,
  generations: HostGenerations,
): Promise<DemoHostConnection> {
  const early = prestarted.get(scenarioId);
  if (early !== undefined) {
    prestarted.delete(scenarioId);
    const reached = await early;
    // A Reset sent from another tab meanwhile moved every tab past it.
    if (reached.generation >= generations.current()) return reached;
    reached.connection.leave();
  }
  return connectAtGeneration(scenarioId, host, generations);
}

async function connectAtGeneration(
  scenarioId: string,
  host: HostModule,
  generations: HostGenerations,
): Promise<DemoHostConnection> {
  let generation = generations.current();
  const connection = await connectSharedHost({
    open: (name) => host.startShared(name),
    name: () => {
      generation = generations.current();
      return hostWorkerName(scenarioId, generation);
    },
    passed: () => generations.advance(generation),
  });
  return { connection, generation };
}

/**
 * Start scenario `scenarioId`'s host now — connect to its SharedWorker, under
 * the name the page's `<DemoScope>` would connect to — so the host's boot (its
 * worker's code, the database, the plugin graph) runs while the page's own
 * bundle loads instead of after it. Called by the demo page's head script,
 * which imports the host module itself (`DemoHost.module`) and this plugin
 * only — nothing of the app — so it runs early; the scope's `connectDemoHost`
 * is handed this connection.
 *
 * Only where this browser already holds the demo's data (`storage`, read by
 * `hostDataStored`): a first visit downloads the whole server and its data,
 * which waits for the visitor to ask (`<DemoScope>`'s gate) — so it starts
 * nothing ahead.
 *
 * Nothing to start where the browser has no SharedWorker: the scope then
 * starts a dedicated worker of its own. A connection whose generation another
 * tab's Reset moved past by the time the scope connects is left; the scope's
 * own worker then takes the storage over (one owner at a time), so only the
 * head start is lost.
 */
export async function prestartDemoHost(
  scenarioId: string,
  storage: string | null,
  host: HostModule,
): Promise<void> {
  if (typeof SharedWorker !== "function") return;
  if (storage === null || !(await hostDataStored(storage))) return;
  if (prestarted.has(scenarioId)) return;
  const connecting = connectAtGeneration(
    scenarioId,
    host,
    trackHostGenerations(scenarioId),
  );
  prestarted.set(scenarioId, connecting);
  await connecting;
}
