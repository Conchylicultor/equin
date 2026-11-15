import { WorkerPreset } from "graphile-worker";
import { SchemaStampPart } from "@plugins/database/plugins/migrations/server";

// graphile-worker's version, read from its public preset: each plugin it ships
// carries the library's version (`dist/version.js`, which the package's
// `exports` map keeps out of reach). A release bundles the library inline, so
// this read touches no file.
function graphileWorkerVersion(): string {
  const versions = new Set(
    (WorkerPreset.plugins ?? []).map((plugin) => plugin.version),
  );
  const [version, ...others] = [...versions];
  if (version === undefined || others.length > 0) {
    throw new Error(
      `[jobs] cannot read graphile-worker's version from WorkerPreset.plugins (found ${JSON.stringify([...versions])}): the queue schema's stamp part needs exactly one`,
    );
  }
  return version;
}

/**
 * The queue schema's part of the schema-layer stamp. An exec child enqueues
 * through the library's SQL (`add_job`, `complete_jobs`, `reschedule_jobs`)
 * but never installs the schema. So a child of code on another graphile
 * version waits until the serving backend has installed that version's queue
 * schema (`install`, its `onReadyBlocking`). Otherwise the deploy window
 * would run the new library against the old schema. See layer-stamp.ts,
 * "Boot DDL outside the layer".
 */
export const queueStampPart = SchemaStampPart({
  id: "jobs.graphile-worker",
  digest: graphileWorkerVersion(),
});
