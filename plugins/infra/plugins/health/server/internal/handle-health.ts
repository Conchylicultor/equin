import { implement } from "@plugins/infra/plugins/endpoints/server";
import { releaseIdentity } from "@plugins/infra/plugins/paths/core";
import { getHealth } from "../../core/endpoints";
import type { HealthResponse } from "../../core/protocol";

const startedAt = Date.now();
// Which build this process IS — a property of the process, exactly like
// `startedAt`, so it is read once. The launcher stamps it into the environment
// before the gateway (and hence this backend) is spawned, so it is already in
// place by the time this module evaluates.
const { runId, composition } = releaseIdentity();

export const handleHealth = implement(getHealth, () => {
  return { ok: true, startedAt, runId, composition } satisfies HealthResponse;
});
