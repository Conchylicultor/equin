import {
  connectSharedHost,
  type SharedHostConnection,
} from "@plugins/framework/plugins/browser-server/core";
import type { DemoHost } from "@plugins/framework/plugins/browser-server/plugins/demo/core";
import { hostWorkerName, type HostGenerations } from "./host-generation";

/** The host module, as the scope imports it (`DemoHost.start`). */
type HostModule = Awaited<ReturnType<DemoHost["start"]>>;

/** A tab's connection to a scenario's host, at the generation it reached. */
export interface DemoHostConnection {
  connection: SharedHostConnection;
  /** The host generation connected to: the one a Reset moves past. */
  generation: number;
}

/**
 * Connect this tab to scenario `scenarioId`'s host — its SharedWorker under the
 * name of the current generation, or of a later one when that generation's
 * worker is retiring (`connectSharedHost` skips it, and the generation moves
 * past it page-wide).
 */
export async function connectDemoHost(
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
