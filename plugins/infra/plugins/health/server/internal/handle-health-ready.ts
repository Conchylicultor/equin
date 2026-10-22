import { implement, HttpError } from "@plugins/infra/plugins/endpoints/server";
import { isServerReady } from "@plugins/framework/plugins/server-core/core";
import { getHealthReady } from "../../core/endpoints";

export const handleHealthReady = implement(getHealthReady, () => {
  if (!isServerReady()) throw new HttpError(503, "server not ready");
  return { ready: true as const };
});
