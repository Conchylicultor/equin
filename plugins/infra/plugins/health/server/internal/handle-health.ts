import { implement } from "@plugins/infra/plugins/endpoints/server";
import { releaseIdentity } from "@plugins/infra/plugins/paths/core";
import { getHealth } from "../../core/endpoints";
import type { HealthResponse } from "../../core/protocol";

const startedAt = Date.now();

export const handleHealth = implement(getHealth, () => {
  // Which build this process IS. The launcher stamps it into the environment
  // before the gateway (and hence this backend) is spawned; read per call, not
  // at module load (a module must not read the environment as it loads —
  // barrel-import's load guard), and an env read is free.
  const { runId, composition } = releaseIdentity();
  return { ok: true, startedAt, runId, composition } satisfies HealthResponse;
});
