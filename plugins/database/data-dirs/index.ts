import { defineDataDir } from "@plugins/infra/plugins/paths/core";

/**
 * `database.json` — where Postgres listens and which managed services the Go
 * gateway supervisor must start before it binds its listener.
 *
 * Written by `./equin start` (and by a release launch) from the embedded
 * cluster's own constants; read by `readDatabaseConfig()` here and by the
 * gateway through its `-db-config` flag. A directory of its own rather than a
 * loose file at the root, because a `DataDir` names a directory and the file
 * needs an owner: it is the one place the TypeScript writer and the Go reader
 * have to agree on.
 */
export const dbConfigDir = defineDataDir({
  kind: "state",
  name: "db-config",
  owner: "database",
  description:
    "database.json — the connection params and managed-service list the gateway supervisor reads at boot",
  // Regenerated from the embedded cluster's constants on every `singularity
  // start`; a missing file already falls back to "plain local Postgres, no
  // managed services", so losing it costs one start, never data.
  reclaim: { kind: "safe" },
});

export default [dbConfigDir];
