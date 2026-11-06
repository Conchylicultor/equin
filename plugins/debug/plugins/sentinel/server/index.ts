import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { ConfigV2 } from "@plugins/config_v2/server";
import { isHostSingleton } from "@plugins/infra/plugins/paths/server";
import { sentinelConfig } from "../core";
import { clusterClass } from "./internal/cluster-class";
import { fleetFlightsClass } from "./internal/fleet-flights";
import { duressEpisodeKind } from "./internal/duress-episode-kind";
import { sentinelDownKind } from "./internal/sentinel-down-kind";
import {
  sentinelStatusServed,
  sentinelStatusWatcher,
  sentinelVitalsServed,
  startStatusWatcher,
  stopStatusWatcher,
} from "./internal/status-resource";
import { startSentinelSampler, stopSentinelSampler } from "./internal/sampler";
import { sentinelWorkerDaemon } from "./internal/worker-host";

export { readDuressEpisodes } from "./internal/read-duress-episodes";

export default {
  description:
    "Cluster congestion sentinel: a main-only always-on sampler + onset detector + duress-latch lifecycle on a dedicated worker thread (host load, Postgres-side wait/lock/IO pressure, fleet state, per-backend health rollup, compressor pressure), feeding the 'cluster' trace ring so every trace gains a cluster-vitals lane, congestion onset is observable, and the latch lease survives a wedged main loop. Persists duress episodes as trip/clear lines on the duress-episodes channel (readDuressEpisodes). Reports the watcher's own supervision status: a host-global status file written on every transition, served on every backend as the sentinel.status push resource (with the duress latch), and a sentinel-down report when main gives up respawning it. Its worker writes the latest reading to a host-global vitals file every tick, served on every backend as the sentinel.vitals push resource.",
  contributions: [
    clusterClass.contribution,
    fleetFlightsClass.contribution,
    duressEpisodeKind,
    sentinelDownKind,
    ...sentinelStatusServed.declare,
    ...sentinelVitalsServed.declare,
    ConfigV2.Register({ descriptor: sentinelConfig }),
  ],
  register: [sentinelStatusWatcher, sentinelWorkerDaemon],
  // The status watcher runs on EVERY backend (each serves the Machine watcher
  // health row from the host-global status file); the sampler itself runs on
  // the host singleton only — the one backend that owns the cluster-wide
  // sampler + duress latch (main in dev, the lone backend in a compiled
  // release; see `isHostSingleton`).
  onReady: async () => {
    // The sampler first: the watcher it guards must never wait on (or be
    // skipped by a failure of) the row that reports on it.
    if (isHostSingleton()) await startSentinelSampler();
    await startStatusWatcher();
  },
  onShutdown: async () => {
    if (isHostSingleton()) await stopSentinelSampler();
    await stopStatusWatcher();
  },
} satisfies ServerPluginDefinition;
